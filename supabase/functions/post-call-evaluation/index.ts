// Supabase Edge Function: post-call-evaluation
// Receives the ElevenLabs post-call webhook, verifies HMAC, persists the run.
// Deploy: supabase functions deploy post-call-evaluation --no-verify-jwt
//
// Canonical ElevenLabs payload (relevant subset):
// {
//   agent_id, conversation_id, started_at, ended_at,
//   transcript: [{ role, message, time_in_call_secs }, ...],
//   tool_calls: [{ tool_name, parameters, result, time_in_call_secs }, ...],
//   analysis: {
//     evaluation_criteria_results: {
//       <criterion_id>: { result: "success" | "failure", rationale: "..." },
//       ...
//     },
//     data_collection_results: { <field>: { value: ..., rationale: "..." } }
//   }
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCENARIO_ID = Deno.env.get("SCENARIO_ID") ??
  "33333333-3333-3333-3333-333333333333";
const WEBHOOK_SECRET = Deno.env.get("ELEVENLABS_WEBHOOK_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- HMAC verification ----------------------------------------------------

async function verifyHmac(rawBody: string, header: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET) return true; // dev only
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
  if (macHex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < macHex.length; i++) diff |= macHex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- Helpers ---------------------------------------------------------------

function safeTimestamp(raw: unknown): string {
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number") {
    return new Date(raw * (raw > 1e12 ? 1 : 1000)).toISOString();
  }
  return new Date().toISOString();
}

// The 5 criteria defined on the agent. Keep in sync with platform_settings.evaluation.criteria.
const CRITERIA_ORDER = [
  "empathy_and_acknowledgement",
  "policy_accuracy",
  "aircover_path_offered",
  "escalation_handling",
  "tone_and_professionalism",
];

type CriterionResult = {
  id: string;
  pass: boolean;
  rationale: string;
};

function normalizeCriteria(raw: Record<string, unknown> | undefined): CriterionResult[] {
  if (!raw) return [];
  const out: CriterionResult[] = [];
  for (const id of CRITERIA_ORDER) {
    const entry = raw[id] as Record<string, unknown> | undefined;
    if (!entry) continue;
    const result = String(entry.result ?? "").toLowerCase();
    out.push({
      id,
      pass: result === "success",
      rationale: String(entry.rationale ?? ""),
    });
  }
  // Include any additional criteria that weren't in our canonical list.
  for (const [id, entry] of Object.entries(raw)) {
    if (CRITERIA_ORDER.includes(id)) continue;
    const e = entry as Record<string, unknown>;
    out.push({
      id,
      pass: String(e.result ?? "").toLowerCase() === "success",
      rationale: String(e.rationale ?? ""),
    });
  }
  return out;
}

function computeOverallScore(criteria: CriterionResult[]): number {
  if (!criteria.length) return 0;
  // Each pass = (10 / N). Round to nearest integer 0..10.
  const ratio = criteria.filter((c) => c.pass).length / criteria.length;
  return Math.round(ratio * 10);
}

function buildCoachingNotes(criteria: CriterionResult[]): Array<{
  flag_type: string;
  severity: "info" | "miss";
  note: string;
  timestamp_in_call: number;
}> {
  return criteria.map((c) => ({
    flag_type: c.pass ? `${c.id}_passed` : `${c.id}_missed`,
    severity: c.pass ? "info" : "miss",
    note: c.rationale || (c.pass ? "Criterion satisfied." : "Criterion not met."),
    timestamp_in_call: 0,
  }));
}

// ---- Handler ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get("ElevenLabs-Signature") ??
    req.headers.get("elevenlabs-signature");
  if (!await verifyHmac(rawBody, sigHeader)) {
    return new Response("signature invalid", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const conversationId = (body.conversation_id as string | undefined) ?? null;

  // Idempotency: if this conversation was already recorded, return existing.
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

  // Criteria results may sit at body.analysis.evaluation_criteria_results OR
  // body.evaluation_criteria_results depending on platform version. Handle both.
  const analysis = (body.analysis as Record<string, unknown> | undefined) ?? {};
  const rawCriteria = (
    (analysis.evaluation_criteria_results as Record<string, unknown> | undefined) ??
    (body.evaluation_criteria_results as Record<string, unknown> | undefined) ??
    {}
  );

  const criteria = normalizeCriteria(rawCriteria);
  const overallScore = computeOverallScore(criteria);
  const criteriaDict: Record<string, { pass: boolean; rationale: string }> = {};
  for (const c of criteria) criteriaDict[c.id] = { pass: c.pass, rationale: c.rationale };

  // Data collection (trainee_name, site, cohort_id)
  const dataCollection = (
    (analysis.data_collection_results as Record<string, Record<string, unknown>> | undefined) ??
    (body.data_collection_results as Record<string, Record<string, unknown>> | undefined) ??
    {}
  );
  const traineeName = String(dataCollection.trainee_name?.value ??
    body.trainee_name ?? "Max (stage demo)");

  const { data: evalRow, error: evalErr } = await supabase
    .from("evaluations")
    .insert({
      scenario_id: SCENARIO_ID,
      conversation_id: conversationId,
      trainee_name: traineeName,
      started_at: safeTimestamp(body.started_at),
      ended_at: body.ended_at ? safeTimestamp(body.ended_at) : null,
      transcript: body.transcript ?? [],
      tool_calls: body.tool_calls ?? [],
      criteria_results: criteriaDict,
      overall_score: overallScore,
      // Legacy columns preserved for backwards compat with older dashboard code.
      policy_score: overallScore,
      empathy_flags: criteria.filter((c) => c.id === "empathy_and_acknowledgement" && !c.pass)
        .map((c) => ({ flag: "missed_empathy", rationale: c.rationale })),
      escalation_flag: criteria.find((c) => c.id === "escalation_handling")?.pass ?? false,
    })
    .select()
    .single();

  if (evalErr || !evalRow) {
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

  // Coaching notes: one row per criterion with its rationale. Gives the UI
  // a live feed to render qualitative feedback beside the quantitative donut.
  const notes = buildCoachingNotes(criteria);
  if (notes.length) {
    const { error: notesErr } = await supabase
      .from("coaching_notes")
      .insert(notes.map((n) => ({ evaluation_id: evalRow.id, ...n })));
    if (notesErr) {
      return new Response(JSON.stringify({ error: notesErr.message }), { status: 500 });
    }
  }

  return new Response(
    JSON.stringify({
      evaluation_id: evalRow.id,
      overall_score: overallScore,
      criteria: criteriaDict,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
