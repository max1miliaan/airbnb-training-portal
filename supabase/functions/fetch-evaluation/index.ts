// Supabase Edge Function: fetch-evaluation
// Portal-triggered pull of conversation analysis from the ElevenLabs API.
// Avoids relying on the flaky post-call webhook for the scorecard reveal.
//
// Call from the portal after endCall():
//   POST /functions/v1/fetch-evaluation { conversation_id: "conv_..." }
// Returns: { evaluation_id, overall_score, criteria_results }
// Also inserts a row into `evaluations` so the existing Realtime path fires.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCENARIO_ID = Deno.env.get("SCENARIO_ID") ??
  "33333333-3333-3333-3333-333333333333";
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CRITERIA_ORDER = [
  "empathy_and_acknowledgement",
  "policy_accuracy",
  "aircover_path_offered",
  "escalation_handling",
  "tone_and_professionalism",
];

type CriterionResult = { pass: boolean; rationale: string };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  let body: { conversation_id?: string; trainee_name?: string };
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }

  const conversationId = body.conversation_id;
  if (!conversationId) return new Response("conversation_id required", { status: 400, headers: CORS });

  // Poll the ElevenLabs API for the conversation — analysis can take 3-10s to appear.
  let analysis: Record<string, unknown> | null = null;
  let conv: Record<string, unknown> | null = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    });
    if (r.ok) {
      conv = await r.json();
      analysis = (conv.analysis as Record<string, unknown>) ?? null;
      const crit = analysis?.evaluation_criteria_results as Record<string, unknown> | undefined;
      if (crit && Object.keys(crit).length > 0) break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  if (!analysis || !conv) {
    return new Response(
      JSON.stringify({ error: "analysis not available yet", conversation_id: conversationId }),
      { status: 504, headers: { ...CORS, "content-type": "application/json" } },
    );
  }

  const rawCriteria = (analysis.evaluation_criteria_results as Record<string, unknown>) ?? {};
  const criteriaDict: Record<string, CriterionResult> = {};
  let passes = 0;
  for (const id of CRITERIA_ORDER) {
    const entry = rawCriteria[id] as Record<string, unknown> | undefined;
    if (!entry) continue;
    const pass = String(entry.result ?? "").toLowerCase() === "success";
    if (pass) passes++;
    criteriaDict[id] = { pass, rationale: String(entry.rationale ?? "") };
  }
  const overallScore = CRITERIA_ORDER.length
    ? Math.round((passes / CRITERIA_ORDER.length) * 10)
    : 0;

  // Idempotency check
  const { data: existing } = await supabase
    .from("evaluations")
    .select("id")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  let evalRow;
  if (existing) {
    const { data } = await supabase
      .from("evaluations")
      .update({
        criteria_results: criteriaDict,
        overall_score: overallScore,
        policy_score: overallScore,
      })
      .eq("conversation_id", conversationId)
      .select()
      .single();
    evalRow = data;
  } else {
    const { data, error } = await supabase
      .from("evaluations")
      .insert({
        scenario_id: SCENARIO_ID,
        conversation_id: conversationId,
        trainee_name: body.trainee_name ?? "Max (stage demo)",
        started_at: conv.start_time_unix_secs
          ? new Date((conv.start_time_unix_secs as number) * 1000).toISOString()
          : new Date().toISOString(),
        ended_at: new Date().toISOString(),
        transcript: conv.transcript ?? [],
        tool_calls: [],
        criteria_results: criteriaDict,
        overall_score: overallScore,
        policy_score: overallScore,
        empathy_flags: [],
        escalation_flag: criteriaDict.escalation_handling?.pass ?? false,
      })
      .select()
      .single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    evalRow = data;
  }

  // Write one coaching_note per criterion so the Feedback tab shows Evaluator badges.
  const notesPayload = Object.entries(criteriaDict).map(([id, c]) => ({
    evaluation_id: evalRow.id,
    flag_type: c.pass ? `${id}_passed` : `${id}_missed`,
    severity: c.pass ? "info" : "miss",
    note: c.rationale,
    timestamp_in_call: 0,
  }));
  if (notesPayload.length && !existing) {
    await supabase.from("coaching_notes").insert(notesPayload);
  }

  return new Response(
    JSON.stringify({
      evaluation_id: evalRow.id,
      overall_score: overallScore,
      criteria: criteriaDict,
    }),
    { status: 200, headers: { ...CORS, "content-type": "application/json" } },
  );
});
