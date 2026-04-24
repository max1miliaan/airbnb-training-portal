// Supabase Edge Function: post-call-evaluation
// Receives the ElevenLabs post-call webhook, verifies HMAC, persists the run + coaching flags.
// Deploy with: supabase functions deploy post-call-evaluation --no-verify-jwt
//
// ElevenLabs webhook payload shape (relevant subset):
// {
//   agent_id, conversation_id, started_at, ended_at,
//   transcript: [{ role, message, time_in_call_secs }, ...],
//   tool_calls: [{ tool_name, parameters, result, time_in_call_secs }, ...],
//   evaluation_criteria_results: { policy_adherence: {score, rationale}, empathy: [...], ... }
// }
//
// Secrets required (set via `supabase secrets set`):
//   SCENARIO_ID                    fallback scenario UUID
//   ELEVENLABS_WEBHOOK_SECRET      HMAC secret matching the agent webhook config
// Auto-injected by platform:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCENARIO_ID = Deno.env.get("SCENARIO_ID") ??
  "33333333-3333-3333-3333-333333333333";
const WEBHOOK_SECRET = Deno.env.get("ELEVENLABS_WEBHOOK_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type Flag = { flag: string; at_seconds: number; severity: "info" | "warn" | "miss"; note: string };

// ---- HMAC verification ----------------------------------------------------
// ElevenLabs sends header `ElevenLabs-Signature: t=<unix>,v0=<hex>` where v0 is
// HMAC-SHA256 of `${t}.${rawBody}` using the shared secret.

async function verifyHmac(rawBody: string, header: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET) return true; // secret not configured -> skip (dev only)
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const sig = parts.v0;
  if (!t || !sig) return false;

  // Reject messages older than 5 minutes (replay protection).
  const ageSec = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(ageSec) || ageSec > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const macHex = Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // constant-time compare
  if (macHex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < macHex.length; i++) diff |= macHex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- Coercion helpers ------------------------------------------------------

function coercePolicyScore(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  // Accept either 0..1 floats (convert to 0..10) or 0..10 ints.
  const scaled = n <= 1 ? n * 10 : n;
  return Math.max(0, Math.min(10, Math.round(scaled)));
}

function safeTimestamp(raw: unknown): string {
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number") return new Date(raw * (raw > 1e12 ? 1 : 1000)).toISOString();
  return new Date().toISOString();
}

function extractFlags(body: Record<string, unknown>): Flag[] {
  const flags: Flag[] = [];
  const evals = (body.evaluation_criteria_results ?? {}) as Record<string, unknown>;

  const empathy = (evals.empathy as Array<Record<string, unknown>>) ?? [];
  for (const e of empathy) {
    flags.push({
      flag: String(e.label ?? "empathy_moment"),
      at_seconds: Number(e.time_in_call_secs ?? 0),
      severity: (e.severity as Flag["severity"]) ?? "info",
      note: String(e.rationale ?? ""),
    });
  }

  const toolCalls = (body.tool_calls as Array<Record<string, unknown>>) ?? [];
  const lookupCall = toolCalls.find((t) => t.tool_name === "lookup_reservation");
  flags.push(
    lookupCall
      ? {
        flag: "tool_lookup_reservation_called",
        at_seconds: Number(lookupCall.time_in_call_secs ?? 0),
        severity: "info",
        note: "Trainee pulled up reservation before quoting policy.",
      }
      : {
        flag: "tool_lookup_reservation_missed",
        at_seconds: 0,
        severity: "miss",
        note: "Trainee quoted policy without verifying reservation details first.",
      },
  );

  const esc = evals.escalation_timing as Record<string, unknown> | undefined;
  if (esc) {
    flags.push({
      flag: esc.triggered ? "escalation_offered" : "escalation_missed",
      at_seconds: Number(esc.time_in_call_secs ?? 0),
      severity: esc.triggered ? "info" : "warn",
      note: String(esc.rationale ?? ""),
    });
  }

  return flags;
}

// ---- Handler ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get("ElevenLabs-Signature") ??
    req.headers.get("elevenlabs-signature");

  const ok = await verifyHmac(rawBody, sigHeader);
  if (!ok) return new Response("signature invalid", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const conversationId = (body.conversation_id as string | undefined) ?? null;

  // Idempotency: if we've already recorded this conversation, return the existing row.
  if (conversationId) {
    const { data: existing } = await supabase
      .from("evaluations")
      .select("id")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (existing) {
      return new Response(
        JSON.stringify({ evaluation_id: existing.id, idempotent: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
  }

  const policyEval = (body.evaluation_criteria_results as Record<string, unknown> | undefined)
    ?.policy_adherence as Record<string, unknown> | undefined;

  const { data: evalRow, error: evalErr } = await supabase
    .from("evaluations")
    .insert({
      scenario_id: SCENARIO_ID,
      conversation_id: conversationId,
      trainee_name: (body.trainee_name as string) ?? "Max (stage demo)",
      started_at: safeTimestamp(body.started_at),
      ended_at: body.ended_at ? safeTimestamp(body.ended_at) : null,
      transcript: body.transcript ?? [],
      policy_score: coercePolicyScore(policyEval?.score),
      tool_calls: body.tool_calls ?? [],
      empathy_flags: (body.evaluation_criteria_results as Record<string, unknown> | undefined)
        ?.empathy ?? [],
      escalation_flag: Boolean(
        (body.evaluation_criteria_results as Record<string, unknown> | undefined)
          ?.escalation_timing &&
          ((body.evaluation_criteria_results as Record<string, unknown>).escalation_timing as
            Record<string, unknown>).triggered,
      ),
    })
    .select()
    .single();

  if (evalErr || !evalRow) {
    // Unique violation -> another concurrent request inserted first; treat as idempotent.
    if (evalErr?.code === "23505" && conversationId) {
      const { data: winner } = await supabase
        .from("evaluations")
        .select("id")
        .eq("conversation_id", conversationId)
        .maybeSingle();
      if (winner) {
        return new Response(
          JSON.stringify({ evaluation_id: winner.id, idempotent: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response(JSON.stringify({ error: evalErr?.message }), { status: 500 });
  }

  const flags = extractFlags(body);
  if (flags.length) {
    const { error: notesErr } = await supabase
      .from("coaching_notes")
      .insert(
        flags.map((f) => ({
          evaluation_id: evalRow.id,
          flag_type: f.flag,
          timestamp_in_call: f.at_seconds,
          note: f.note,
          severity: f.severity,
        })),
      );
    if (notesErr) {
      return new Response(JSON.stringify({ error: notesErr.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ evaluation_id: evalRow.id, flags_written: flags.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
