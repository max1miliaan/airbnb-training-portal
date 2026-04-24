// Supabase Edge Function: post-call-evaluation
// Receives the ElevenLabs post-call webhook, persists the run + coaching flags.
// Deploy with: supabase functions deploy post-call-evaluation --no-verify-jwt
//
// ElevenLabs webhook payload shape (relevant subset):
// {
//   agent_id, conversation_id, started_at, ended_at,
//   transcript: [{ role, message, time_in_call_secs }, ...],
//   tool_calls: [{ tool_name, parameters, result, time_in_call_secs }, ...],
//   evaluation_criteria_results: { policy_adherence: {score, rationale}, empathy: [...], ... }
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCENARIO_ID = Deno.env.get("SCENARIO_ID") ??
  "33333333-3333-3333-3333-333333333333";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type Flag = { flag: string; at_seconds: number; severity: "info" | "warn" | "miss"; note: string };

function extractFlags(body: Record<string, unknown>): Flag[] {
  const flags: Flag[] = [];
  const evals = (body.evaluation_criteria_results ?? {}) as Record<string, unknown>;

  // Empathy indicators — structured as a list of moments in the call.
  const empathy = (evals.empathy as Array<Record<string, unknown>>) ?? [];
  for (const e of empathy) {
    flags.push({
      flag: String(e.label ?? "empathy_moment"),
      at_seconds: Number(e.time_in_call_secs ?? 0),
      severity: (e.severity as Flag["severity"]) ?? "info",
      note: String(e.rationale ?? ""),
    });
  }

  // Tool usage — did the trainee call lookup_reservation?
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

  // Escalation timing
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const policyEval = (body.evaluation_criteria_results as Record<string, unknown> | undefined)
    ?.policy_adherence as Record<string, unknown> | undefined;

  const { data: evalRow, error: evalErr } = await supabase
    .from("evaluations")
    .insert({
      scenario_id: SCENARIO_ID,
      trainee_name: (body.trainee_name as string) ?? "Max (stage demo)",
      started_at: body.started_at,
      ended_at: body.ended_at,
      transcript: body.transcript ?? [],
      policy_score: policyEval?.score ?? null,
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
