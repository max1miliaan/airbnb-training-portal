# Hosting the demo

Three options, ranked by demo-day reliability.

## Option 1 — GitHub Pages (recommended)

**Why this is the right default:**
- Browsers require HTTPS for `getUserMedia()` microphone access on any origin other than `localhost`. GitHub Pages gives you free HTTPS with a stable URL.
- Leave-behind link after the interview is worth more than a screenshot: `https://<user>.github.io/airbnb-training-portal/` stays up indefinitely.
- Version-controlled, rollback-able, free.

**What's safe to commit:**
- `SUPABASE_ANON_KEY` — designed for client exposure. Row-Level Security on the Supabase side enforces what the key can and cannot touch. Anon can read the demo tables; service role (never in the browser) can write.
- `ELEVENLABS_AGENT_ID` — designed for client exposure. The ConvAI widget takes this as a public attribute.
- `env.js` — committed on purpose. See `.gitignore`.

**What's NEVER committed:**
- `.env.local` (used by `scripts/deploy-airbnb-training.sh`)
- Supabase service-role key (lives inside the edge function's secrets, never the repo)
- ElevenLabs API key (never needed in the browser)

**Setup (~5 min):**

```bash
cd /Users/Max/Projects/elevenlabs-agents/demos/airbnb-training-portal
git init
git add .
git commit -m "feat: initial portal"
gh repo create airbnb-training-portal --public --source=. --push
gh repo edit --enable-pages --pages-branch main --pages-path /
# Or use the GH web UI: Settings -> Pages -> Source: main / root
```

Then open `https://<your-gh-username>.github.io/airbnb-training-portal/`.

**If you want a private repo:** `gh repo create airbnb-training-portal --private --source=. --push` then upgrade to a GH Pro/Team plan for Pages on private repos, OR use Cloudflare Pages / Netlify / Vercel (all free, HTTPS, private-repo-friendly).

## Option 2 — Cloudflare Pages (alternative)

Same benefits as GH Pages, works with private repos for free.

```bash
cd /Users/Max/Projects/elevenlabs-agents/demos/airbnb-training-portal
npx wrangler pages deploy .
```

## Option 3 — Local `python3 -m http.server` (stage rehearsal only)

```bash
python3 -m http.server 8765
open http://localhost:8765/
```

Works fine for rehearsal. Cannot use off the laptop. Do NOT rely on this for the live demo — mic permission behaviour, firewall issues, and "is the server still running?" anxiety all pile up. Use option 1 or 2 for the real thing.

## What hosting does NOT solve

- Network dropout on the venue WiFi — have the fallback video (`F` key) ready
- ElevenLabs rate limiting — well within demo limits (1000 calls/day on the agent)
- Supabase cold start on first call — prime it by running the flow once 5 minutes before the demo
