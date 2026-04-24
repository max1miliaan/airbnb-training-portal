// Copy to env.js (gitignored) and fill in. Loaded before app.js.
// Without this file, the portal runs in DEMO_MODE (fabricated call script) —
// perfect for stage rehearsal without a live agent or Supabase.
window.__ENV = {
  // Supabase values — fill in after creating the project.
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  // Live ElevenLabs agent — already deployed via CLI on 2026-04-24.
  ELEVENLABS_AGENT_ID: 'agent_6301kpzby1v6e7htj43jkk6zef64',
};
