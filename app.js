// Airbnb x ElevenLabs Agent Training Portal.
//
// Uses @elevenlabs/client SDK directly (not the embeddable widget) so that:
//   - One-click start: clicking "Begin scenario" kicks off Conversation.startSession()
//     immediately. No second click on a widget button.
//   - Full event control: onMessage/onModeChange/onStatusChange/onError give us
//     typed hooks we can route straight into the portal's state machine.
//   - The right-rail behind-the-scenes panels update live from the same event
//     stream — transcript, objectives, eval scores, coaching flags.
//
// Env loading: inline config via env.js (gitignored by default; safe to commit
// once you're on GH Pages because SUPABASE_ANON_KEY + ELEVENLABS_AGENT_ID are
// both designed for client exposure). Absent env.js => DEMO_MODE (fabricated
// script) for stage rehearsal without a live backend.

import { Conversation } from 'https://esm.sh/@elevenlabs/client@0.8.1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---- Config ---------------------------------------------------------------

const env = window.__ENV ?? {};
const HAS_AGENT = Boolean(env.ELEVENLABS_AGENT_ID);
const HAS_SUPABASE = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
const SCENARIO_ID = '33333333-3333-3333-3333-333333333333';
const TRAINEE_NAME = env.TRAINEE_NAME ?? 'Max';
const TRAINEE_SITE = env.TRAINEE_SITE ?? 'Atlanta';

const supa = HAS_SUPABASE ? createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY) : null;

// ---- DOM refs -------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const orb = $('orb');
const orbLabel = $('orb-label');
const orbSub = $('orb-sub');
const statusDot = $('status-dot');
const statusLabel = $('status-label');
const timer = $('timer');
const btnStart = $('btn-start');
const btnEnd = $('btn-end');
const btnAgain = $('btn-again');
const scorebar = $('scorebar');
const transcriptBody = $('transcript-body');
const transcriptMeta = $('transcript-meta');
const coachingCount = $('coaching-count');
const coachingList = $('coaching-list');
const fallbackEl = $('fallback');
const fallbackVideo = $('fallback-video');

// ---- State ----------------------------------------------------------------

const state = {
  status: 'idle',
  startedAt: null,
  tickHandle: null,
  turnCount: 0,
  activeNode: null,
  evaluationId: null,
  objectives: new Set(),
  convo: null,
};

const liveScores = { policy: 0, empathyCount: 0, toolUsed: false, escalationFired: false };
const liveFlags = new Set();

function elapsed() {
  return state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
}
function log(...args) { console.info('[portal]', ...args); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Visual state helpers ------------------------------------------------

function setStatus(next) {
  state.status = next;
  statusDot.classList.remove('live', 'done', 'connecting');
  const labels = { idle: 'Ready', connecting: 'Connecting...', live: 'Live call', ended: 'Call ended' };
  statusLabel.textContent = labels[next] ?? next;
  if (next === 'live') statusDot.classList.add('live');
  else if (next === 'ended') statusDot.classList.add('done');
  else if (next === 'connecting') statusDot.classList.add('connecting');
}

// Map workflow node → role label + orb theme class.
function roleForNode(nodeId) {
  if (nodeId === 'mid_coaching')   return { name: 'Coach',          theme: 'coach-mid' };
  if (nodeId === 'debrief')        return { name: 'Debrief coach',  theme: 'coach-debrief' };
  // Dispatch (silent tool node) — keep transient theme, neutral label.
  if (nodeId && nodeId.startsWith('node_')) return { name: 'Scoring', theme: 'dispatch' };
  return { name: 'Sarah', theme: 'sarah' };
}

// "Your turn" only makes sense when Sarah is the speaker. For coach/debrief
// the trainee is listening, not preparing to respond.
function listeningHintFor(role) {
  return role.theme === 'sarah' ? 'Your turn' : 'Listen for the tip';
}

// Heuristic fallback for when the SDK doesn't deliver workflow_node_id with
// the agent message. Coach, debrief, and Sarah each have distinctive opening
// phrasing we can detect from the first ~240 chars.
//
// Note: "Jumping back now." is the coach's EXIT phrase, not an opener. It is
// deliberately absent here — finding it should NOT keep us in coach.
const COACH_OPENERS_RE = /\b(?:i need to pause here|let'?s pause|quick tip|here'?s a tip|pause for a moment|i'?m the coach|coach speaking|coaching tip|you'?ve done (?:the )?heavy lifting|here'?s the phrase|here'?s what to say|try saying)\b/i;
const DEBRIEF_OPENERS_RE = /\b(?:here'?s? (?:your|the) debrief|let'?s? break (?:this|that) down|overall you scored|let'?s? go through (?:your|the) call|(?:the |your )?scorecard|reviewing your call|debrief time|that wraps the call|let me walk you through|empathy and acknowledgement[: ]|policy accuracy[: ])\b/i;
// Sarah's voice is unmistakable from her v3 expressive tags — they only ship
// on customer_call turns (per agent prompt). Match the first tag bracket.
const SARAH_OPENERS_RE = /\[(?:frustrated|sigh|firm|softer|relieved|disappointed|resigned|anxious)\]/i;
function maybeRetitleFromAgentText(text) {
  const head = text.slice(0, 240);
  let inferred = null;
  if (state.activeWorkflowNode !== 'mid_coaching' && COACH_OPENERS_RE.test(head)) inferred = 'mid_coaching';
  else if (state.activeWorkflowNode !== 'debrief' && DEBRIEF_OPENERS_RE.test(head)) inferred = 'debrief';
  else if (state.activeWorkflowNode !== 'customer_call' && SARAH_OPENERS_RE.test(head)) inferred = 'customer_call';
  if (inferred) {
    log('inferred workflow node from text', inferred);
    state.activeWorkflowNode = inferred;
    applyNodeTheme(inferred);
  }
}

function applyNodeTheme(nodeId) {
  const role = roleForNode(nodeId);
  orb.classList.remove('theme-sarah', 'theme-coach-mid', 'theme-coach-debrief', 'theme-dispatch');
  orb.classList.add(`theme-${role.theme}`);
  // Refresh label so the orb retitles on handover even if onModeChange fired first
  // with the previous node still cached in state.activeWorkflowNode.
  if (orb.classList.contains('speaking'))       setOrb('speaking',  `${role.name} is speaking`);
  else if (orb.classList.contains('listening')) setOrb('listening', `${role.name} is listening`, listeningHintFor(role));
  else if (orb.classList.contains('thinking'))  setOrb('thinking',  `${role.name} is thinking`);
}

function setOrb(kind, label, sub) {
  orb.classList.remove('speaking', 'idle', 'listening', 'thinking');
  if (kind) orb.classList.add(kind);
  if (label !== undefined) orbLabel.textContent = label;
  if (sub !== undefined) orbSub.textContent = sub;
}

function setActiveNode(nodeId) {
  state.activeNode = nodeId;
  const order = ['start', 'customer', 'debrief', 'end'];
  const idx = order.indexOf(nodeId);
  $$('.node').forEach((n) => {
    n.classList.remove('active', 'done');
    const myIdx = order.indexOf(n.dataset.node);
    if (n.dataset.node === nodeId) n.classList.add('active');
    else if (myIdx >= 0 && myIdx < idx) n.classList.add('done');
  });
}

function hitObjective(key) {
  if (state.objectives.has(key)) return;
  state.objectives.add(key);
  const el = document.querySelector(`.obj[data-obj="${key}"]`);
  if (el) el.classList.add('hit');
  const total = document.querySelectorAll('.obj').length;
  const struck = document.querySelectorAll('.obj.hit').length;
  const fill = $('obj-progress-fill');
  if (fill) fill.style.width = (total ? (struck / total) * 100 : 0) + '%';
}

function tickTimer() {
  if (!state.startedAt) return;
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  timer.textContent = `${mm}:${ss}`;
}
function startTimer() { state.startedAt = Date.now(); tickTimer(); state.tickHandle = setInterval(tickTimer, 500); }
function stopTimer() { clearInterval(state.tickHandle); state.tickHandle = null; }

// ---- Transcript -----------------------------------------------------------

function formatTime(s) {
  if (s == null) return '—';
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Strip ElevenLabs v3 emotion tags ([frustrated], [sigh], [softer], etc.) from
// transcript text before rendering. Tags drive the TTS engine but are noise on
// the demo screen. Keep stripping conservative: only match short single-word
// bracket tags so we don't eat tool-call payloads or legitimate brackets.
const EMOTION_TAG_RE = /\s*\[(?:frustrated|sigh|softer|anxious|resigned|relieved|disappointed|firm|sad|happy|neutral|angry|excited|whisper|shout|laugh|laughs|laughing|crying|cries|breath|breathes|breathing|pause|pauses)\]\s*/gi;
function stripEmotionTags(text) {
  if (!text) return text;
  return String(text).replace(EMOTION_TAG_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

function addLine(role, text, opts = {}) {
  if (!text) return;
  if (role === 'guest' || role === 'agent' || role === 'coach' || role === 'debrief') text = stripEmotionTags(text);
  const line = document.createElement('div');
  const isToolRow = role === 'tool';
  line.className = 'line ' + (isToolRow ? 'tool' : '');
  // 'guest' is the historical label for any agent-side voice. Re-map it to the
  // active workflow role so the transcript shows "Coach" / "Debrief" instead
  // of "Sarah" while a non-Sarah node is speaking.
  let effectiveRole = role;
  if (role === 'guest') {
    if (state.activeWorkflowNode === 'mid_coaching') effectiveRole = 'coach';
    else if (state.activeWorkflowNode === 'debrief') effectiveRole = 'debrief';
  }
  const roleLbl = { guest: 'Sarah', agent: 'You', coach: 'Coach', debrief: 'Debrief', tool: 'tool', system: 'system' }[effectiveRole] ?? effectiveRole;
  const roleClass = { guest: 'guest', agent: 'agent', coach: 'coach', debrief: 'debrief', tool: 'tool', system: 'system' }[effectiveRole] ?? '';
  const ts = opts.time ?? elapsed();
  line.innerHTML = `
    <span class="line-role ${roleClass}">${roleLbl}</span>
    <div class="line-body">
      <div class="line-text">${escapeHtml(text)}</div>
      <div class="line-ts">${formatTime(ts)}</div>
    </div>
  `;
  transcriptBody.appendChild(line);
  transcriptBody.parentElement.scrollTop = transcriptBody.parentElement.scrollHeight;
  state.turnCount += 1;
  transcriptMeta.textContent = `${state.turnCount} turn${state.turnCount === 1 ? '' : 's'}`;
}

// ---- Tabs -----------------------------------------------------------------

$$('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    t.classList.add('active');
    $(`panel-${t.dataset.tab}`).classList.add('active');
  });
});

// ---- Buttons --------------------------------------------------------------

btnStart.addEventListener('click', startCall);
btnEnd.addEventListener('click', endCall);
btnAgain.addEventListener('click', resetCall);
$('fallback-close').addEventListener('click', toggleFallback);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'f' || e.key === 'F') toggleFallback();
  if (e.key === 'Escape' && fallbackEl.classList.contains('visible')) toggleFallback();
});

function toggleFallback() {
  const v = fallbackEl.classList.toggle('visible');
  if (v) {
    // Lazy-load the src on first open so a missing file doesn't 404 on every page load.
    const src = fallbackVideo.dataset.src;
    if (src && !fallbackVideo.src) fallbackVideo.src = src;
  } else {
    fallbackVideo.pause();
  }
}

// ---- Call lifecycle -------------------------------------------------------

async function startCall() {
  // Defensive: if a previous session is still lingering in memory, kill it
  // before starting a new one. Protects against double-click or restart-after-stall.
  if (state.convo) {
    log('startCall found stale convo; ending it first');
    try { await state.convo.endSession(); } catch (e) { log('stale endSession err', e); }
    state.convo = null;
  }

  btnStart.classList.add('hide');
  btnEnd.classList.remove('hide');
  setStatus('connecting');
  setOrb('thinking', 'Connecting to Sarah...', 'Requesting microphone access');
  setActiveNode('start');

  // Gate on permissions API instead of pre-grabbing the mic — the SDK does its
  // own getUserMedia internally and a probe-then-release pattern races with it
  // on some browsers, leaving the SDK with a stopped track.
  try {
    if (navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: 'microphone' });
      log('mic permission state', p.state);
      if (p.state === 'denied') {
        addLine('system', 'Microphone is blocked. Click the lock icon in the URL bar and allow microphone, then try again.');
        resetCall();
        return;
      }
    }
  } catch (e) { log('permissions.query unsupported', e); }

  startTimer();
  setActiveNode('customer');

  if (!HAS_AGENT) {
    log('DEMO_MODE — no ELEVENLABS_AGENT_ID in env.js, running fabricated script');
    addLine('system', 'Running in DEMO_MODE (no live agent). Fabricated script will play.');
    runDemoScript();
    return;
  }

  try {
    state.convo = await Conversation.startSession({
      agentId: env.ELEVENLABS_AGENT_ID,
      // REQUIRED: without this, the SDK defaults to WebSocket and the user's
      // mic audio does not reach the agent reliably. WebRTC uses LiveKit to
      // publish the local audio track properly.
      connectionType: 'webrtc',
      // Inject runtime context so Sarah's prompt renders `{{trainee_name}}` + `{{site}}`.
      dynamicVariables: {
        trainee_name: TRAINEE_NAME,
        site: TRAINEE_SITE,
      },
      onConnect: () => {
        setStatus('live');
        setOrb('listening', 'Sarah is connecting...', 'Your turn in a moment');
        log('connected');
      },
      onDisconnect: (...args) => {
        log('disconnected', args);
        if (state.status !== 'ended') endCall();
      },
      onMessage: (evt) => {
        // SDK 0.8.1 primary shape: { source: 'user' | 'ai', message: string, agent_metadata: {...} }
        log('message', evt);
        handleToolEvent(evt);
        // Track active workflow node so the orb can relabel for coach nodes.
        // Re-apply theme on every message that carries a node id, even when it
        // matches state — guards against the SDK delivering the first audio
        // frame before the node id is cached, which would otherwise leave the
        // orb labelled "Sarah is speaking" while the coach is actually talking.
        const nodeId = evt.agent_metadata?.workflow_node_id ?? evt.agentMetadata?.workflow_node_id;
        if (nodeId) {
          const changed = nodeId !== state.activeWorkflowNode;
          state.activeWorkflowNode = nodeId;
          if (changed) log('workflow node', nodeId);
          applyNodeTheme(nodeId);
        }
        const src = evt.source ?? evt.role ?? (evt.type?.includes('user') ? 'user' : 'ai');
        const text = evt.message ?? evt.text ?? evt.content ?? '';
        if (!text || !String(text).trim()) return;
        if (src === 'user' || src === 'human') {
          addLine('agent', String(text));
          inferObjectives(String(text));
        } else {
          // Content-pattern fallback: if the SDK omitted workflow_node_id but
          // the message text gives away the speaker, retitle the orb before
          // we render the line — otherwise the line label says "Sarah" while
          // the coach is talking.
          maybeRetitleFromAgentText(String(text));
          addLine('guest', String(text));
        }
      },
      onModeChange: ({ mode }) => {
        log('mode', mode);
        const role = roleForNode(state.activeWorkflowNode);
        if (mode === 'speaking') setOrb('speaking', `${role.name} is speaking`);
        else if (mode === 'listening') setOrb('listening', `${role.name} is listening`, listeningHintFor(role));
        else if (mode === 'thinking') setOrb('thinking', `${role.name} is thinking`);
        if (mode === 'speaking' || mode === 'thinking') {
          orb.classList.remove('user-speaking');
          orb.style.setProperty('--vol', '0');
        }
      },
      onStatusChange: ({ status }) => log('status', status),
      onError: (err) => {
        log('error', err);
        addLine('system', `Error: ${err?.message ?? err}. Press F for fallback.`);
      },
      // Client tools callable from the agent side (none defined server-side; placeholder).
      clientTools: {},
    });
    log('conversation started', state.convo);
    window.__convo = state.convo;
    // Live-glow orb while the user is speaking. Poll getInputVolume() every 80ms
    // and drive a --vol CSS var. Threshold 0.04 to ignore ambient noise.
    if (state.volTimer) clearInterval(state.volTimer);
    state.volTimer = setInterval(() => {
      if (!state.convo?.getInputVolume) return;
      const v = state.convo.getInputVolume();
      if (v > 0.04) {
        orb.classList.add('user-speaking');
        orb.style.setProperty('--vol', String(Math.min(1, v * 3)));
      } else {
        orb.classList.remove('user-speaking');
        orb.style.setProperty('--vol', '0');
      }
    }, 80);
    // Grab conversation_id so we can fetch the eval by ID after endCall.
    try {
      state.conversationId = state.convo?.getId?.() ?? state.convo?.conversationId ?? null;
      log('conversation_id', state.conversationId);
    } catch (e) { log('getId err', e); }
  } catch (err) {
    // Surface the real error instead of silently dropping into demo mode —
    // easier to debug on stage, and the presenter can retry with Begin.
    const msg = err?.message ?? String(err);
    log('startSession failed', err);
    addLine('system', `Could not start call: ${msg}. Click Begin again or press ⇧R to reset.`);
    setStatus('idle');
    setOrb('idle', 'Call failed to start', msg);
    btnEnd.classList.add('hide');
    btnStart.classList.remove('hide');
    stopTimer();
  }
}

async function endCall() {
  btnEnd.classList.add('hide');
  btnStart.classList.add('hide');
  stopTimer();
  setStatus('ended');
  setActiveNode('debrief');
  setOrb('thinking', 'Call ended — scoring...', 'Fetching evaluation from ElevenLabs. Scorecard appears in a few seconds.');

  const convoId = state.conversationId || state.convo?.getId?.() || null;
  if (state.volTimer) { clearInterval(state.volTimer); state.volTimer = null; }
  orb.classList.remove('user-speaking');
  orb.style.setProperty('--vol', '0');
  if (state.convo) {
    try { await state.convo.endSession(); } catch (err) { log('endSession err', err); }
    state.convo = null;
  }

  if (!HAS_SUPABASE) {
    setTimeout(applyDemoEvaluation, 900);
    return;
  }

  if (!convoId) {
    setOrb('idle', 'No conversation ID captured.', 'Could not fetch scorecard. Press Shift+R and try again.');
    return;
  }

  // Progress feedback — ElevenLabs eval analysis takes 10-30s after end_call.
  // Stash the timer on state so paintEvaluation can kill it immediately when
  // the scorecard lands (from Realtime, direct-fetch, or agent-dispatched tool).
  let elapsed = 0;
  state.progressTimer = setInterval(() => {
    elapsed += 3;
    if (state.evaluationId) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
      return;
    }
    setOrb('thinking', 'Call ended — scoring...', `Evaluator is reviewing the transcript (${elapsed}s).`);
  }, 3000);
  const progressTimer = state.progressTimer;

  // Direct-fetch evaluation. Retries up to 3 times if the ElevenLabs analysis
  // pipeline hasn't finished yet (504 from the edge proxy).
  const doFetch = async (attempt) => {
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-evaluation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ conversation_id: convoId, trainee_name: TRAINEE_NAME }),
    });
    if (r.status === 504 && attempt < 3) {
      log(`fetch-evaluation attempt ${attempt} timed out; retrying in 10s`);
      await new Promise((res) => setTimeout(res, 10000));
      return doFetch(attempt + 1);
    }
    if (!r.ok) throw new Error(`fetch-evaluation ${r.status}`);
    return r.json();
  };

  try {
    const data = await doFetch(1);
    clearInterval(progressTimer);
    log('fetch-evaluation ok', data);
    if (data.overall_score != null) {
      paintEvaluation({
        id: data.evaluation_id,
        overall_score: data.overall_score,
        criteria_results: data.criteria,
        escalation_flag: data.criteria?.escalation_handling?.pass ?? false,
        empathy_flags: [],
        tool_calls: [],
      });
      Object.entries(data.criteria || {}).forEach(([id, c]) => {
        appendCoaching({
          flag_type: c.pass ? `${id}_passed` : `${id}_missed`,
          severity: c.pass ? 'info' : 'miss',
          note: c.rationale,
          timestamp_in_call: 0,
          source: 'evaluator',
        });
      });
    }
  } catch (err) {
    clearInterval(progressTimer);
    log('fetch-evaluation failed', err);
    setOrb('idle', 'Evaluation fetch failed.', `${err.message}. Press Shift+R and try again.`);
  }
}

// Canonical 5 criteria shown on the scorecard, in display order.
const CRITERIA = [
  { id: 'empathy_and_acknowledgement', statusId: 'crit-empathy-status' },
  { id: 'policy_accuracy',             statusId: 'crit-policy-status' },
  { id: 'aircover_path_offered',       statusId: 'crit-aircover-status' },
  { id: 'escalation_handling',         statusId: 'crit-escalation-status' },
  { id: 'tone_and_professionalism',    statusId: 'crit-tone-status' },
];

function setCriterionState(critId, state, rationale) {
  const def = CRITERIA.find((c) => c.id === critId);
  if (!def) return;
  const statusEl = $(def.statusId);
  if (statusEl) statusEl.dataset.state = state;
  const row = statusEl?.closest('.criterion');
  if (row) row.dataset.state = state;
  if (rationale != null) {
    const rid = def.statusId.replace('-status', '-rationale');
    const rEl = $(rid);
    if (rEl) rEl.textContent = rationale;
  }
}

function setDonut(score, totalCriteria) {
  const donut = $('donut');
  const num = $('donut-score');
  if (!donut || !num) return;
  const pct = Math.max(0, Math.min(100, (score / 10) * 100));
  donut.style.setProperty('--pct', pct.toString());
  donut.classList.remove('good', 'mid', 'bad');
  if (score >= 8) donut.classList.add('good');
  else if (score >= 5) donut.classList.add('mid');
  else if (score > 0) donut.classList.add('bad');
  num.textContent = String(score);
  const label = $('scorecard-label');
  const sub = $('scorecard-sub');
  if (label && sub) {
    if (score >= 8) { label.textContent = 'Strong performance'; sub.textContent = `${score}/10 — passed ${score/2} of ${totalCriteria ?? CRITERIA.length} criteria.`; }
    else if (score >= 5) { label.textContent = 'Room to refine'; sub.textContent = `${score}/10 — review the missed criteria below.`; }
    else if (score > 0) { label.textContent = 'Needs practice'; sub.textContent = `${score}/10 — focus on empathy first and the AirCover path.`; }
    else { label.textContent = 'Awaiting call completion'; sub.textContent = 'Start the scenario — the evaluator scores 5 dimensions after you end the call.'; }
  }
}

function resetCall() {
  stopTimer();
  state.startedAt = null;
  state.turnCount = 0;
  state.activeWorkflowNode = null;
  applyNodeTheme(null);
  state.objectives = new Set();
  liveScores.policy = 0; liveScores.empathyCount = 0; liveScores.toolUsed = false; liveScores.escalationFired = false;
  liveFlags.clear();
  _firedEdgeDispatch.clear();
  _seenToolCalls.clear();
  transcriptBody.innerHTML = '';
  transcriptMeta.textContent = '0 turns';
  timer.textContent = '00:00';
  scorebar?.classList.remove('visible');
  if (btnAgain) btnAgain.style.display = 'none';
  setStatus('idle');
  setOrb('idle', 'Tap begin to start the scenario', 'Sarah will open with a complaint about her cancelled booking. Your job: pull up the reservation, acknowledge the context, apply the Firm policy, and offer the AirCover path.');
  setActiveNode(null);
  $$('.obj').forEach((o) => o.classList.remove('hit'));
  btnStart.classList.remove('hide');
  btnEnd.classList.add('hide');
  // Reset criteria to pending + donut to 0
  CRITERIA.forEach((c) => setCriterionState(c.id, 'pending', null));
  setDonut(0);
  const sbResult = $('sb-result');
  if (sbResult) { sbResult.textContent = 'Scorecard populates in the right panel when the call ends.'; sbResult.classList.remove('live'); }
  coachingList.innerHTML = `<div class="flag info placeholder"><div class="flag-icon">i</div><div><div class="flag-title">Feedback populates during the call</div><div class="flag-note">Live checks stream in as you speak. Evaluator rationale arrives when the call ends and auto-switches to the Scorecard.</div></div><div class="flag-time">—</div></div>`;
  coachingCount.classList.add('hide');
}

// ---- Tool events ---------------------------------------------------------
// The ElevenLabs SDK emits tool activity across several event shapes depending
// on version. We catch them all here so the audience sees the `lookup_reservation`
// call land in the transcript + flash the rubric + reveal the reservation card.

const _seenToolCalls = new Set();

// Names of internal workflow-edge dispatch tools the platform auto-creates.
// They fire when the LLM judges that an edge condition is met. We use them
// as the most reliable signal that a node transition just happened, but we
// hide them from the audience-facing transcript (they're plumbing, not
// content) and we suppress duplicates aggressively because the LLM
// occasionally retries them in a loop.
const EDGE_DISPATCH_TOOLS = new Set([
  'notify_condition_1_met', 'notify_condition_2_met',
  'notify_condition_3_met', 'notify_condition_4_met',
]);

// Direction-aware target inference. notify_condition_1_met fires on the
// customer_coaching edge in BOTH directions (the platform requires one edge
// per node pair), so we toggle off the current node instead of using a
// static map. notify_condition_2/3_met fire forward only.
function inferEdgeTarget(toolName) {
  const cur = state.activeWorkflowNode;
  if (toolName === 'notify_condition_1_met') {
    return cur === 'mid_coaching' ? 'customer_call' : 'mid_coaching';
  }
  if (toolName === 'notify_condition_2_met' || toolName === 'notify_condition_3_met' || toolName === 'notify_condition_4_met') {
    if (cur === 'debrief') return 'end';
    return 'debrief';
  }
  return null;
}

function handleToolEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  const kind = evt.type ?? evt.event ?? null;
  const isToolCall = kind === 'client_tool_call' || kind === 'tool_call' || evt.tool_call || evt.client_tool_call;
  const isToolResp = kind === 'agent_tool_response' || kind === 'tool_response' || evt.tool_response;

  if (isToolCall) {
    const call = evt.client_tool_call ?? evt.tool_call ?? evt;
    const toolName = call.tool_name ?? call.name ?? 'unknown_tool';
    const callId = call.tool_call_id ?? call.id ?? `${toolName}-${Date.now()}`;
    if (_seenToolCalls.has(callId)) return;
    _seenToolCalls.add(callId);
    const params = call.parameters ?? call.arguments ?? {};

    // --- Edge dispatch (workflow transition) ---------------------------
    if (EDGE_DISPATCH_TOOLS.has(toolName)) {
      // Skip transcript line — internal plumbing, not content.
      // Dedup ONLY when target == current node (LLM looping in place).
      // Any dispatch that flips us OUT of the current node must go through,
      // otherwise the orb gets stuck on coach/debrief after a back-transition.
      const targetNode = inferEdgeTarget(toolName);
      const cur = state.activeWorkflowNode;
      if (targetNode && targetNode !== cur) {
        log('edge dispatch -> flipping node theme', toolName, cur, '->', targetNode);
        state.activeWorkflowNode = targetNode;
        applyNodeTheme(targetNode);
        maybeIngestNestedScorecard(params);
      } else {
        log('edge dispatch ignored (already in target)', toolName, 'cur=', cur, 'target=', targetNode);
      }
      return;
    }

    const paramStr = Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    addLine('tool', `${toolName}(${paramStr})`, { time: elapsed() });
    if (toolName === 'lookup_reservation') {
      onLookupCalled(params);
    }
    if (toolName === 'submit_scorecard') {
      onScorecardSubmitted(params);
    }
  }

  if (isToolResp) {
    const resp = evt.tool_response ?? evt;
    const toolName = resp.tool_name ?? resp.name ?? 'tool';
    // Suppress edge-dispatch tool responses from transcript / handlers.
    if (EDGE_DISPATCH_TOOLS.has(toolName)) return;
    if (toolName === 'lookup_reservation') {
      onLookupResponded(resp.result ?? resp.response_data ?? null);
    }
  }
}

// notify_condition_2_met sometimes ships submit_scorecard as a nested-tools
// JSON string (CLI/runtime quirk). Try to extract it.
function maybeIngestNestedScorecard(params) {
  try {
    const nested = params?.nested_tools ?? params?.nestedTools;
    if (!nested) return;
    const obj = typeof nested === 'string' ? JSON.parse(nested) : nested;
    const sc = obj?.submit_scorecard ?? obj?.submitScorecard;
    if (sc) onScorecardSubmitted(sc);
  } catch (e) {
    log('nested scorecard parse failed', e?.message);
  }
}

// Fired when the agent calls submit_scorecard (directly or nested in an
// edge dispatch). Switches the right rail to the Scorecard tab and previews
// the donut + criteria immediately, ahead of the post-call Supabase fetch.
function onScorecardSubmitted(params) {
  log('scorecard submitted (live)', params);
  // Normalise camelCase / snake_case from the LLM.
  const get = (k1, k2) => params?.[k1] ?? params?.[k2];
  const overall = Number(get('overall_score', 'overallScore')) || 0;
  const liveCriteria = {
    empathy_and_acknowledgement: { pass: !!get('empathy_pass',     'empathyPass') },
    policy_accuracy:             { pass: !!get('policy_pass',      'policyPass') },
    aircover_path_offered:       { pass: !!get('aircover_pass',    'aircoverPass') },
    escalation_handling:         { pass: !!get('escalation_pass',  'escalationPass') },
    tone_and_professionalism:    { pass: !!get('tone_pass',        'tonePass') },
  };
  // Switch tab.
  const scorecardTab = document.querySelector('.tab[data-tab="eval"]');
  if (scorecardTab && !scorecardTab.classList.contains('active')) scorecardTab.click();
  // Paint criteria + donut. Rationales arrive later from the Supabase eval
  // row; we show pass/fail now so the audience sees movement.
  if (typeof CRITERIA !== 'undefined' && Array.isArray(CRITERIA)) {
    CRITERIA.forEach((c) => {
      const r = liveCriteria[c.id];
      if (r) setCriterionState(c.id, r.pass ? 'pass' : 'fail', null);
    });
  }
  if (typeof setDonut === 'function') setDonut(overall, 5);
}

function onLookupCalled(params) {
  hitObjective('lookup');
  liveScores.toolUsed = true;
  liveFlag(
    'tool_fired',
    'info',
    'lookup_reservation_fired',
    `Tool call dispatched with ${params.confirmation_code ?? 'no code'}. Reservation about to reveal.`,
  );
  const card = document.getElementById('reservation-card');
  if (card) {
    card.classList.remove('hidden');
    card.classList.add('reveal');
  }
}

function onLookupResponded(result) {
  if (result && typeof result === 'object') log('lookup_reservation result', result);
}

// ---- Live coach (mid-call) -----------------------------------------------
function liveFlag(id, severity, type, note) {
  if (liveFlags.has(id)) return;
  liveFlags.add(id);
  appendCoaching({ flag_type: type, timestamp_in_call: elapsed(), note, severity, source: 'live' });
}

function inferObjectives(trainee) {
  // Drives the LEFT-rail "Four moves to land" checklist in real time from
  // trainee utterances. The authoritative scoring comes from the ElevenLabs
  // eval webhook post-call — this is just qualitative progress feedback.
  const t = (trainee || '').toLowerCase();

  if (/pull up|pulling up|confirmation code|let me find|reservation (?:number|details)|hm[a-z0-9]{3,}/.test(t)) {
    hitObjective('lookup');
  }
  // Empathy requires BOTH an empathy phrase AND a specific context anchor in the
  // same utterance. "That must be frustrating" alone (about wait time) does not
  // qualify — must name the anniversary, the illness, or repeated calls.
  const empathyVerb = /(i'?m so sorry|that (?:sounds|must be)|incredibly stressful|difficult week|i understand|i hear you|terrible|awful)/;
  const contextAnchor = /(anniversary|illness|sick|partner|husband|wife|fever|flu|doctor|trip|getaway|repeated call|called (?:twice|three|multiple)|documented)/;
  if (empathyVerb.test(t) && contextAnchor.test(t)) {
    hitObjective('empathy');
  }
  if (/(firm (?:policy|cancellation)|five days|5 days|0\s?percent|zero percent|standard refund)/.test(t)) {
    hitObjective('policy');
  }
  // AirCover requires the literal concept — generic "different solutions" or
  // "let me check" does not qualify.
  if (/(aircover|extenuating(?: circumstances)?|extenuating[- ]circumstances? review)/.test(t)) {
    hitObjective('aircover');
  }
  if (/(supervisor|transfer you|escalat|connect you with|senior agent)/.test(t)) {
    // No visible UI item for escalation in the four-move checklist — flag only,
    // do not increment the objectives bar.
    liveFlag('escalation_on_time', 'info', 'escalation_offered', 'Supervisor route offered.');
  }
  if (/^(ok|okay|alright|so)[.,]/.test(t) && elapsed() < 15 && !liveFlags.has('strong_ack')) {
    liveFlag('missed_empathy', 'warn', 'missed_emotional_context', 'Opened with a mechanical acknowledgement.');
  }
}

// ---- Supabase Realtime → evaluation + coaching --------------------------

if (supa) {
  supa.channel('evaluations-stream')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'evaluations' }, (payload) => {
      log('realtime evaluation', payload.new);
      paintEvaluation(payload.new);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'coaching_notes' }, (payload) => {
      log('realtime coaching note', payload.new);
      appendCoaching({ ...payload.new, source: 'evaluator' });
    })
    .subscribe((s) => log('supabase realtime', s));
}

function paintEvaluation(row) {
  // Guard against double-paint: Realtime + fetch-evaluation + tool-dispatched
  // can all fire for the same conversation. First one wins; ignore the rest.
  if (state.evaluationId && state.evaluationId === row.id) {
    log('paintEvaluation skip — already painted', row.id);
    return;
  }
  state.evaluationId = row.id;
  setActiveNode('end');
  if (state.evalTimeout) { clearTimeout(state.evalTimeout); state.evalTimeout = null; }
  // Kill the progress ticker immediately so the orb doesn't flap back to
  // "Call ended — scoring..." after we celebrate below.
  if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  // Auto-switch to the Scorecard tab so the donut reveal is the money shot.
  const scorecardTab = document.querySelector('.tab[data-tab="eval"]');
  if (scorecardTab && !scorecardTab.classList.contains('active')) scorecardTab.click();

  // criteria_results is the canonical source of truth now. Shape:
  //   { empathy_and_acknowledgement: { pass: bool, rationale: "..." }, ... }
  const criteria = row.criteria_results && typeof row.criteria_results === 'object' ? row.criteria_results : {};
  const overall = row.overall_score != null ? row.overall_score : computeOverallFromCriteria(criteria);

  CRITERIA.forEach((c) => {
    const r = criteria[c.id];
    if (!r) { setCriterionState(c.id, 'pending', null); return; }
    setCriterionState(c.id, r.pass ? 'pass' : 'fail', r.rationale || null);
  });

  setDonut(overall, CRITERIA.length);

  const sbResult = $('sb-result');
  if (sbResult) {
    const passes = Object.values(criteria).filter((c) => c && c.pass).length;
    sbResult.textContent = `Evaluator returned: ${overall}/10 · ${passes} of ${CRITERIA.length} criteria passed.`;
    sbResult.classList.add('live');
  }
  scorebar?.classList.add('visible');
  if (btnAgain) btnAgain.style.display = '';
  const headline =
    overall >= 8 ? 'Strong call — well played.' :
    overall >= 5 ? 'Call scored — room to refine.' :
                   'Call scored — see what to practise.';
  setOrb('idle', headline, `${overall}/10 — full breakdown on the right. Press "Practice again" when ready.`);
}

function computeOverallFromCriteria(criteria) {
  const entries = Object.values(criteria || {});
  if (!entries.length) return 0;
  const passes = entries.filter((c) => c && c.pass).length;
  return Math.round((passes / entries.length) * 10);
}

function appendCoaching(note) {
  const placeholder = coachingList.querySelector('.flag.placeholder');
  if (placeholder) placeholder.remove();
  const source = note.source || 'live';
  const el = document.createElement('div');
  el.className = `flag ${note.severity || 'info'} flag-${source}`;
  const icon = { info: 'i', warn: '!', miss: 'x' }[note.severity || 'info'];
  const badge = source === 'evaluator'
    ? '<span class="flag-source src-evaluator">Evaluator</span>'
    : '<span class="flag-source src-live">Live check</span>';
  el.innerHTML = `
    <div class="flag-icon">${icon}</div>
    <div class="flag-body">
      <div class="flag-title-row">
        <div class="flag-title">${escapeHtml(formatFlagLabel(note.flag_type))}</div>
        ${badge}
      </div>
      <div class="flag-note">${escapeHtml(note.note || '')}</div>
    </div>
    <div class="flag-time">${formatTime(note.timestamp_in_call)}</div>
  `;
  coachingList.appendChild(el);
  const n = coachingList.querySelectorAll('.flag:not(.placeholder)').length;
  coachingCount.textContent = n;
  coachingCount.classList.remove('hide');
}

function formatFlagLabel(t) {
  return (t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Dashboard ----------------------------------------------------------

async function loadDashboard() {
  const body = $('dash-body');
  if (!supa) {
    body.innerHTML = '';
    DEMO_RUNS.forEach((r) => body.appendChild(dashRow(r)));
    return;
  }
  const { data, error } = await supa
    .from('evaluations')
    .select('trainee_name, started_at, policy_score, tool_calls, empathy_flags, escalation_flag')
    .eq('scenario_id', SCENARIO_ID)
    .order('started_at', { ascending: false })
    .limit(6);
  body.innerHTML = '';
  if (error || !data?.length) {
    log('dashboard fallback', error);
    DEMO_RUNS.forEach((r) => body.appendChild(dashRow(r)));
    return;
  }
  data.forEach((r) => {
    const toolUsed = Array.isArray(r.tool_calls) && r.tool_calls.some((t) => (t.tool ?? t.tool_name) === 'lookup_reservation');
    const flags = Array.isArray(r.empathy_flags) ? r.empathy_flags.length : 0;
    body.appendChild(dashRow({
      trainee: r.trainee_name, site: parseSite(r.trainee_name),
      policy: r.policy_score ?? 0, flags, tool: toolUsed, when: relative(r.started_at),
    }));
  });
}
function parseSite(name) { const m = /\(([^)]+)\)/.exec(name || ''); return m ? m[1] : '—'; }
function relative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dashRow(r) {
  const tr = document.createElement('tr');
  const bucket = r.policy >= 8 ? 'good' : r.policy >= 5 ? 'mid' : 'bad';
  tr.innerHTML = `
    <td>${escapeHtml(r.trainee.split(' (')[0])}</td>
    <td style="color: var(--text-subtle);">${escapeHtml(r.site || '—')}</td>
    <td><span class="dash-score ${bucket}">${r.policy}</span></td>
    <td>${r.flags}</td>
    <td>${r.tool ? '<span style="color: var(--success); font-weight: 700;">✓</span>' : '<span style="color: var(--miss); font-weight: 700;">—</span>'}</td>
    <td style="color: var(--text-subtle);">${escapeHtml(r.when)}</td>
  `;
  return tr;
}

// ---- Demo script (no-env fallback) --------------------------------------

const DEMO_RUNS = [
  { trainee: 'Maya R.', site: 'Atlanta', policy: 8, flags: 1, tool: true, when: '3h ago' },
  { trainee: 'Marcus D.', site: 'Atlanta', policy: 6, flags: 1, tool: true, when: '1d ago' },
  { trainee: 'Elena V.', site: 'Portland', policy: 9, flags: 2, tool: true, when: '1d ago' },
  { trainee: 'Jordan B.', site: 'Portland', policy: 5, flags: 1, tool: false, when: '2d ago' },
  { trainee: 'Ade O.', site: 'San Francisco', policy: 7, flags: 1, tool: true, when: '3d ago' },
];

async function runDemoScript() {
  const beats = [
    { t: 200,  role: 'guest', text: 'Hi — I need to talk to someone about a booking I had to cancel. I am not getting my money back and I do not understand why.' },
    { t: 2800, role: 'agent', text: "I'm so sorry you're dealing with this. That sounds like a really stressful week. Let me pull up your reservation — can I get the confirmation code?" },
    { t: 2200, role: 'guest', text: 'HMXYZ8423.' },
    { t: 1400, role: 'tool',  text: 'lookup_reservation({confirmation_code:"HMXYZ8423"}) -> {listing:"Waterfront Villa", policy:"Firm", days_before_checkin:5, total_paid:2145}' },
    { t: 1600, role: 'agent', text: 'OK, I have your reservation here — 4 nights at the Waterfront Villa, anniversary trip. I can see you cancelled on May 3rd, five days before check-in.' },
    { t: 2600, role: 'guest', text: 'Right. My partner got the flu. We had a doctor-s note. Five years of planning this trip.' },
    { t: 2800, role: 'agent', text: 'That is awful. Because the listing is on a Firm policy and the cancellation came within 7 days of check-in, the standard refund would be 0 percent — but because you have medical documentation, we can open an AirCover extenuating circumstances review.' },
    { t: 2400, role: 'guest', text: 'What does that mean?' },
    { t: 2200, role: 'agent', text: 'A reviewer will contact you within 3 business days. You would send them the doctor-s note and a short description of what happened. They have the discretion to approve a full refund.' },
    { t: 2400, role: 'guest', text: 'OK. And how long does that take?' },
    { t: 2000, role: 'agent', text: 'Three business days for first contact. Usually resolved within a week. I will flag this as priority given the documentation.' },
    { t: 2200, role: 'guest', text: 'Thank you. That is more helpful than I expected.' },
  ];
  for (const b of beats) {
    await wait(b.t);
    if (b.role === 'guest') setOrb('speaking', 'Sarah is speaking');
    else if (b.role === 'agent') setOrb('listening', 'Sarah is listening', 'Your turn');
    addLine(b.role, b.text);
    if (b.role === 'agent') inferObjectives(b.text);
    if (b.role === 'tool') { hitObjective('lookup'); liveScores.toolUsed = true; updateLiveCriterion('tool', 1, 1); $('crit-tool-value').textContent = 'Used'; }
  }
  await wait(1400);
  endCall();
}

function applyDemoEvaluation() {
  // Fabricated 4/5 pass for stage rehearsal without a live backend.
  const fake = {
    id: 'demo-' + Date.now(),
    overall_score: 8,
    criteria_results: {
      empathy_and_acknowledgement: { pass: true,  rationale: 'Opened with "I am so sorry you are dealing with this" before any policy talk.' },
      policy_accuracy:             { pass: true,  rationale: 'Cited Firm cancellation policy and the 0% bracket at 5 days out cleanly.' },
      aircover_path_offered:       { pass: true,  rationale: 'Offered an AirCover extenuating-circumstances review anchored to the doctor\'s note.' },
      escalation_handling:         { pass: true,  rationale: 'Sarah did not mention chargeback — criterion not triggered (n/a counted as pass).' },
      tone_and_professionalism:    { pass: false, rationale: 'Tone steadied after beat 3 but the opening read as slightly rushed — trainee should slow down.' },
    },
    tool_calls: [{ tool: 'lookup_reservation', at_seconds: 12, ok: true }],
  };
  paintEvaluation(fake);
  const notes = [
    { severity: 'info',  flag_type: 'strong_acknowledgement',         timestamp_in_call: 4,   note: 'Opened with "I am so sorry you are dealing with this" before any policy talk. Sets the tone for the rest of the call.' },
    { severity: 'info',  flag_type: 'tool_lookup_reservation_called', timestamp_in_call: 12,  note: 'Called lookup_reservation before quoting any refund number. Textbook.' },
    { severity: 'info',  flag_type: 'policy_cited_correctly',         timestamp_in_call: 78,  note: 'Cited Firm + 5-day window + 0 percent bracket in one clean sentence.' },
    { severity: 'info',  flag_type: 'aircover_path_offered',          timestamp_in_call: 95,  note: 'Offered AirCover review specifically because documentation exists — not a generic fallback.' },
    { severity: 'warn',  flag_type: 'specifics_could_be_tighter',     timestamp_in_call: 128, note: 'Walked through the timeline well, but did not explicitly name the medical-documentation qualifier. Small, but matters for compliance auditing.' },
  ];
  notes.forEach((n, i) => setTimeout(() => appendCoaching({ ...n, source: 'evaluator' }), 180 * (i + 1)));
}

// ---- Boot ---------------------------------------------------------------

log('boot', { HAS_AGENT, HAS_SUPABASE, AGENT_ID: env.ELEVENLABS_AGENT_ID });
const envPill = $('env-pill');
if (envPill) {
  if (HAS_AGENT && HAS_SUPABASE) { envPill.textContent = 'Live'; envPill.classList.remove('demo'); }
  else { envPill.textContent = 'Demo'; envPill.classList.add('demo'); }
}
resetCall();
loadDashboard();
setActiveNode(null);

// ---- Hard-reset + unload safety ----------------------------------------
// If the user refreshes or closes the tab mid-call, end the session cleanly
// so we don't leave orphaned agents running on the ElevenLabs side.
window.addEventListener('beforeunload', () => {
  try { state.convo?.endSession(); } catch {}
});
window.addEventListener('pagehide', () => {
  try { state.convo?.endSession(); } catch {}
});

// Hard reset keyboard shortcut: Shift+R at any time terminates any live session
// and restores the UI to ready-to-begin. Useful on stage if anything stalls.
async function hardReset() {
  log('hard reset');
  if (state.convo) {
    try { await state.convo.endSession(); } catch (e) { log('hardReset endSession err', e); }
    state.convo = null;
  }
  resetCall();
  addLine('system', 'Session reset. Click Begin scenario to try again.');
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.shiftKey && (e.key === 'R' || e.key === 'r')) { e.preventDefault(); hardReset(); }
});
// Also bind the "Practice again" button to always work as a full hard reset.
btnAgain?.addEventListener('click', hardReset);
// Expose on window for stage emergencies via devtools.
window.__hardReset = hardReset;
