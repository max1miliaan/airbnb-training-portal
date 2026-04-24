# Airbnb Agent Training Portal — Demo

Live training-portal demo for the 2026-04-27 ElevenLabs Sales Lead Canada roleplay. An Airbnb-branded HTML portal that embeds an ElevenLabs Conversational AI agent (Sarah Chen, frustrated guest disputing a cancellation), renders the workflow / prompt / KB / live eval / coaching / dashboard panels, and persists scoring + coaching notes to Supabase via an edge-function webhook.

Lives inside the `elevenlabs-agents` workspace so the `@elevenlabs/cli` pushes the agent + tool from `../../agent_configs/Airbnb-Training-Cancellation-Dispute.json` and `../../tool_configs/lookup-reservation.json`.

## Stage-day runbook (2026-04-27, 1pm EST)

**90 minutes before:**
- Open `index.html` in Chrome with mic access granted (NOT Comet — SIGTRAP)
- One full rehearsal, verify `evaluations` row writes + coaching flags appear
- Keep fallback video tab pre-loaded (`assets/fallback-demo.mp4`)

**During the 8-minute demo slot:**
1. Part 1 live call (4 min): click **Start training call**, handle Sarah as the trainee
2. Pause at first exchange for the voice-quality beat (talk-track ~8:30)
3. Part 2 behind the scenes (4 min): click through Workflow -> Prompt -> Knowledge -> Evaluation -> Coaching -> Dashboard
4. Close on the live eval scores from the call you just ran

**If anything breaks:**
- Press `F` — fallback video plays
- Press `M` — mic mute toggle (visual in top-right too)
- Worst case, refresh; `resetCall()` runs on boot

## Setup from zero

### 1. ElevenLabs agent + tool (via CLI)

From `/Users/Max/Projects/elevenlabs-agents/`:

```bash
elevenlabs auth login                           # one-time, stores in keychain
elevenlabs tools push                           # deploys tool_configs/lookup-reservation.json
elevenlabs agents push                          # deploys agent_configs/Airbnb-Training-Cancellation-Dispute.json
elevenlabs agents list                          # grab the agent_id for the new agent
```

Open the agent in the ElevenLabs dashboard and:
- Upload `../../prompts/airbnb-training/firm-policy-kb.md` as a knowledge base file, then paste the returned KB id into the agent config's `knowledge_base[0].id` and push again
- Pick a frustrated female voice in the dashboard and paste the voice id into `conversation_config.tts.voice_id`, then push again
- In the agent's Webhook settings, set post-call transcription to point at the deployed Supabase edge function URL (see step 2)

### 2. Supabase (schema + edge function)

```bash
# Create Supabase project at supabase.com (free tier is fine for a demo)
# Then in the SQL editor:
#   paste supabase/schema.sql  -> run
#   paste supabase/seed.sql    -> run

# From this directory, deploy the edge function:
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy post-call-evaluation --no-verify-jwt
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=... SCENARIO_ID=33333333-3333-3333-3333-333333333333
```

Paste the deployed function URL into the ElevenLabs agent's post-call webhook.

### 3. Portal env

```bash
cp env.example.js env.js
# edit env.js — paste SUPABASE_URL + SUPABASE_ANON_KEY + ELEVENLABS_AGENT_ID
python3 -m http.server 8000
open http://localhost:8000/
```

Without `env.js`, the portal runs in DEMO_MODE — a fabricated ~75s call script that's ideal for rehearsal without the full stack wired.

## Files

```
index.html                             three-pane portal
styles.css                             Airbnb brand tokens + layout
app.js                                 state machine, ConvAI wiring, Supabase Realtime
env.example.js                         template — copy to env.js (gitignored)
assets/
  fallback-demo.mp4                    pre-recorded 90s clean run (gitignored, record locally)
supabase/
  schema.sql                           6-table schema + lookup_reservation RPC + RLS
  seed.sql                             1 listing, reservation HMXYZ8423, Firm matrix, 5 prior runs
  functions/
    post-call-evaluation/index.ts      Deno edge function, receives ElevenLabs webhook
```

Agent-side artefacts live one level up, in the CLI-managed layout:

```
../../agent_configs/Airbnb-Training-Cancellation-Dispute.json
../../tool_configs/lookup-reservation.json
../../prompts/airbnb-training/system-prompt.md       # source of truth for the persona
../../prompts/airbnb-training/firm-policy-kb.md      # upload to ElevenLabs KB
../../prompts/airbnb-training/evaluation-criteria.md # maps to platform_settings.evaluation.criteria
```

## Non-goals

- Multi-language (talk track says "show", not "build")
- Mobile responsiveness (stage demo is desktop)
- BPO partner SSO/RBAC (demo, not a product)
- PowerPoint fallback (live HTML is the demo; video is the fallback)
