// Supabase Edge Function: submit-scorecard
// Called by the ElevenLabs agent as a webhook tool during the debrief node.
// Payload shape the agent sends:
// {
//   conversation_id: string,
//   trainee_name: string,
//   overall_score: number (0..10),
//   empathy_pass: boolean, empathy_rationale: string,
//   policy_pass:  boolean, policy_rationale:  string,
//   aircover_pass: boolean, aircover_rationale: string,
//   escalation_pass: boolean, escalation_rationale: string,
//   tone_pass: boolean, tone_rationale: string,
//   takeaway: string
// }
// Inserts a row into evaluations + one coaching_note per criterion.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCENARIO_ID = Deno.env.get("SCENARIO_ID") ??
  "33333333-3333-3333-3333-333333333333";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }

  // The ElevenLabs CLI auto-camelCases property keys on push, so the webhook
  // body arrives with camelCase. Accept both variants for robustness.
  const pick = (snake: string, camel: string) => body[snake] ?? body[camel];

  const criteria_results = {
    empathy_and_acknowledgement: { pass: Boolean(pick("empathy_pass", "empathyPass")), rationale: String(pick("empathy_rationale", "empathyRationale") ?? "") },
    policy_accuracy:             { pass: Boolean(pick("policy_pass", "policyPass")),  rationale: String(pick("policy_rationale", "policyRationale") ?? "") },
    aircover_path_offered:       { pass: Boolean(pick("aircover_pass", "aircoverPass")), rationale: String(pick("aircover_rationale", "aircoverRationale") ?? "") },
    escalation_handling:         { pass: Boolean(pick("escalation_pass", "escalationPass")), rationale: String(pick("escalation_rationale", "escalationRationale") ?? "") },
    tone_and_professionalism:    { pass: Boolean(pick("tone_pass", "tonePass")), rationale: String(pick("tone_rationale", "toneRationale") ?? "") },
  };

  // RECOMPUTE overall_score server-side from the 5 pass booleans. Ignores
  // whatever number the agent sent — prevents float/percent confusion bugs.
  const passCount = Object.values(criteria_results).filter((c) => c.pass).length;
  const clampedOverall = passCount * 2; // 5 criteria * 2 = max 10
  const agentClaimed = Number(pick("overall_score", "overallScore") ?? 0);
  if (Math.round(agentClaimed) !== clampedOverall) {
    console.log(`agent claimed ${agentClaimed}, recomputed ${clampedOverall} from ${passCount}/5 passes`);
  }

  // Idempotency by conversation_id
  const conversationId = ((pick("conversation_id", "conversationId")) as string | undefined) ?? null;
  if (conversationId) {
    const { data: existing } = await supabase
      .from("evaluations")
      .select("id")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ evaluation_id: existing.id, idempotent: true }),
        { status: 200, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  const { data: evalRow, error: evalErr } = await supabase
    .from("evaluations")
    .insert({
      scenario_id: SCENARIO_ID,
      conversation_id: conversationId,
      trainee_name: String(pick("trainee_name", "traineeName") ?? "Max (stage demo)"),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      transcript: [],
      tool_calls: [],
      criteria_results,
      overall_score: clampedOverall,
      policy_score: clampedOverall,
      empathy_flags: [],
      escalation_flag: criteria_results.escalation_handling.pass,
    })
    .select()
    .single();

  if (evalErr || !evalRow) {
    return new Response(JSON.stringify({ error: evalErr?.message }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }

  const notes = Object.entries(criteria_results).map(([id, c]) => ({
    evaluation_id: evalRow.id,
    flag_type: c.pass ? `${id}_passed` : `${id}_missed`,
    severity: c.pass ? "info" : "miss",
    note: c.rationale,
    timestamp_in_call: 0,
  }));
  // Also add the takeaway as a separate note if provided
  if (body.takeaway) {
    notes.push({
      evaluation_id: evalRow.id,
      flag_type: "coach_takeaway",
      severity: "info",
      note: String(body.takeaway),
      timestamp_in_call: 0,
    });
  }
  if (notes.length) await supabase.from("coaching_notes").insert(notes);

  return new Response(
    JSON.stringify({ evaluation_id: evalRow.id, overall_score: clampedOverall }),
    { status: 200, headers: { ...CORS, "content-type": "application/json" } },
  );
});
