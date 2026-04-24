-- Schema patch 02 — training-center scoring overhaul (2026-04-24).
-- Idempotent. Run in Supabase SQL editor after schema-patch-01.sql.

-- 1. criteria_results: full per-criterion pass/fail + rationale dict from
-- ElevenLabs post-call evaluation. Canonical source of truth for the donut.
alter table evaluations
  add column if not exists criteria_results jsonb not null default '{}'::jsonb;

-- 2. overall_score: computed convenience column (0..10). Passes x 2.
alter table evaluations
  add column if not exists overall_score int check (overall_score between 0 and 10);

-- 3. Realtime still publishes evaluations + coaching_notes from patch 01.

-- 4. Backfill existing rows with a zero overall_score so the dashboard doesn't
-- show NULL while we migrate.
update evaluations
   set overall_score = 0
 where overall_score is null;
