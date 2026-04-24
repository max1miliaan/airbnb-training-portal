# Go-Live Runbook — Supabase + GitHub Pages

Step-by-step sequence to get the portal talking to the real ElevenLabs agent (`agent_6301kpzby1v6e7htj43jkk6zef64`) from a public HTTPS URL. Total time ~25 minutes.

## Current state

- ElevenLabs agent: LIVE. `agent_6301kpzby1v6e7htj43jkk6zef64`. GPT-5.2, v3 conversational voice (Sarah), Drew voice override on debrief, 5 KB files RAG-attached, lookup_reservation tool on the customer node.
- lookup_reservation tool: LIVE at ElevenLabs (`tool_1777021521528`) — URL currently points at `REPLACE-WITH-SUPABASE-PROJECT-REF.supabase.co`, so the tool will fail at runtime until Supabase is wired up and the tool re-pushed.
- Portal: local only. `demos/airbnb-training-portal/`. Runs in DEMO_MODE today (fabricated script).
- Supabase: not yet provisioned.
- GitHub Pages: not yet published.

## Step 1 — Create the Supabase project (5 min)

1. Go to https://supabase.com/dashboard/new
2. Name: `airbnb-agent-training-demo`, region closest to you (us-east-1 is fine)
3. Set a strong DB password — save it
4. Wait ~2 min for provisioning
5. From Project Settings → API, copy:
   - **Project URL** (looks like `https://xyz.supabase.co`)
   - **anon public key** (long JWT)
   - **service_role key** (DANGER — never put in the browser, only in edge function secrets)

## Step 2 — Apply schema + seed (2 min)

From the Supabase SQL editor:

1. Paste the contents of `supabase/schema.sql`, run
2. Paste the contents of `supabase/seed.sql`, run
3. Verify: SQL editor → `select confirmation_code, guest_name, status from reservations;` — should return row `HMXYZ8423 | Sarah Chen | cancelled`

## Step 3 — Deploy the edge function (3 min)

From the portal directory:

```bash
cd /Users/Max/Projects/elevenlabs-agents/demos/airbnb-training-portal

# One-time: install supabase CLI if you don't have it
brew install supabase/tap/supabase

supabase login                                     # browser-based auth
supabase link --project-ref <YOUR_PROJECT_REF>     # the part before .supabase.co
supabase functions deploy post-call-evaluation --no-verify-jwt
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service_role_key_from_step_1>
supabase secrets set SCENARIO_ID=33333333-3333-3333-3333-333333333333
```

Save the function URL it prints (looks like `https://<ref>.supabase.co/functions/v1/post-call-evaluation`).

## Step 4 — Update the lookup_reservation tool (2 min)

The tool currently has a placeholder URL. Edit `/Users/Max/Projects/elevenlabs-agents/tool_configs/lookup-reservation.json`:

```bash
# From the elevenlabs-agents root
cd /Users/Max/Projects/elevenlabs-agents

# Replace placeholders (macOS sed)
PROJECT_URL=https://<YOUR_PROJECT_REF>.supabase.co
ANON_KEY=<your_anon_key>

sed -i '' "s|https://REPLACE-WITH-SUPABASE-PROJECT-REF.supabase.co|$PROJECT_URL|g" tool_configs/lookup-reservation.json
sed -i '' "s|REPLACE_WITH_SUPABASE_ANON_KEY|$ANON_KEY|g" tool_configs/lookup-reservation.json

elevenlabs tools push
```

## Step 5 — Set the post-call webhook on the agent (1 min)

In the ElevenLabs dashboard:

1. Open the `Airbnb Training — Cancellation Dispute` agent
2. Settings → Webhooks → Post-call transcription
3. Paste the Supabase function URL from step 3
4. Save

From now on, every call the agent finishes posts the transcript + eval results to Supabase. The portal's right rail picks it up via Supabase Realtime.

## Step 6 — Portal env (30 sec)

```bash
cd /Users/Max/Projects/elevenlabs-agents/demos/airbnb-training-portal
cp env.example.js env.js
# Edit env.js — paste SUPABASE_URL + SUPABASE_ANON_KEY (ELEVENLABS_AGENT_ID already filled in)
```

## Step 7 — Local verification before publishing (2 min)

```bash
python3 -m http.server 8765
open http://localhost:8765/
```

Click **Start training call**. You should:

- See the ConvAI widget appear bottom-right (not the DEMO_MODE fabricated script)
- Hear Sarah open with her frustrated line
- See the workflow graph advance: Start → Customer highlighted
- Say "Let me pull up your reservation, what's the confirmation code?" → Sarah responds "HMXYZ8423" → see the `lookup_reservation` tool call card in the transcript → right-rail lights up the lookup objective
- Complete the call naturally (offer AirCover review)
- Post-call: see a real row in Supabase `evaluations` table + coaching flags render in the right rail

If any step fails, the troubleshooting section below covers it.

## Step 8 — Publish to GitHub Pages (5 min)

```bash
cd /Users/Max/Projects/elevenlabs-agents/demos/airbnb-training-portal

git init
git add .
git commit -m "feat: initial portal"

# Public repo so GH Pages is free. env.js is safe to commit — see HOSTING.md.
gh repo create airbnb-training-portal --public --source=. --push

# Enable Pages — main branch, root
gh api -X POST repos/:owner/airbnb-training-portal/pages \
  -f "build_type=legacy" \
  -f "source[branch]=main" \
  -f "source[path]=/"
```

Wait ~60 seconds, then open `https://<your-gh-username>.github.io/airbnb-training-portal/`.

**Private-repo alternative:** use Cloudflare Pages instead (`npx wrangler pages deploy .`) — free, HTTPS, private-repo-friendly.

## Step 9 — Final verification from the live URL (2 min)

Same flow as step 7 but from the GH Pages URL:

1. Open the Pages URL in Chrome (not Comet — SIGTRAP)
2. Grant mic permission when prompted (HTTPS unblocks `getUserMedia`)
3. Run one full call, confirm the Supabase row lands + coaching flags render
4. Bookmark it — this is your stage URL

## How the pieces link up

```
 ┌───────────────────────────────────────────────────────────────────┐
 │  GH Pages                                                         │
 │  https://<user>.github.io/airbnb-training-portal/                 │
 │                                                                   │
 │   index.html  styles.css  app.js  env.js                          │
 │                     │                                             │
 │                     │ mounts <elevenlabs-convai agent-id="...">   │
 │                     ▼                                             │
 │                ElevenLabs Conversational AI                       │
 │                agent_6301kpzby1v6e7htj43jkk6zef64                 │
 │                                                                   │
 │      Sarah talks <──── audio WebRTC ────>  Max (trainee)          │
 │                                                                   │
 │       │                                                           │
 │       │ calls lookup_reservation(confirmation_code=HMXYZ8423)     │
 │       ▼                                                           │
 │   Supabase REST        (SUPABASE_URL/rest/v1/rpc/lookup_reservat) │
 │       │                                                           │
 │       │ returns reservation + Firm policy + refund matrix         │
 │       ▼                                                           │
 │   Sarah reads fact to Max, Max applies policy                     │
 │                                                                   │
 │   ... call ends ...                                               │
 │                                                                   │
 │   ElevenLabs fires post-call webhook  ─────▶  Supabase edge fn    │
 │       post-call-evaluation inserts                                │
 │       rows into evaluations + coaching_notes                      │
 │                      │                                            │
 │                      │ Realtime push                              │
 │                      ▼                                            │
 │   Portal right-rail renders final scores + coaching flags         │
 └───────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Widget never loads | Missing `env.js` or wrong agent id | Check browser devtools; confirm `window.__ENV` has all three fields |
| Widget loads, mic blocked | `file://` or HTTP origin | Serve over `localhost` or HTTPS (GH Pages) |
| Sarah doesn't speak | Widget loaded but agent_id mismatched | Re-check `ELEVENLABS_AGENT_ID` matches `agent_6301kpzby1v6e7htj43jkk6zef64` |
| Tool call fails mid-conversation | Tool URL still has the `REPLACE-WITH-SUPABASE-PROJECT-REF` placeholder | Re-do step 4 |
| No `evaluations` row after call | Webhook not configured on agent, or edge function not deployed | Dashboard → agent webhook tab. `supabase functions logs post-call-evaluation` |
| CORS errors in console hitting Supabase | Supabase project CORS defaults allow all — if you customised it, add your GH Pages origin | Supabase dashboard → Settings → API → Additional Origins |
