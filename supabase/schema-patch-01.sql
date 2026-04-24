-- Schema patch 01 — pre-demo hardening (2026-04-24).
-- Idempotent. Run in Supabase SQL editor after schema.sql.

-- 1. conversation_id on evaluations, for idempotency + correlation to ElevenLabs
alter table evaluations
  add column if not exists conversation_id text;

create unique index if not exists uq_evaluations_conversation_id
  on evaluations(conversation_id)
  where conversation_id is not null;

-- 2. index on started_at for dashboard ordering
create index if not exists idx_evaluations_started_at
  on evaluations(started_at desc);

-- 3. Realtime publication for dashboard live-updates
-- Wrapped in DO so re-running doesn't 42710 on already-added tables.
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table evaluations';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table coaching_notes';
  exception when duplicate_object then null;
  end;
end $$;

-- 4. Replace lookup_reservation with a camelCase-parameter version.
-- The ElevenLabs CLI (v0.5.1) auto-transforms request_body_schema property
-- keys to camelCase on push, so the webhook body will be
-- {"confirmationCode": "..."}. PostgREST matches JSON keys to function
-- parameter names by exact string; we therefore need a parameter literally
-- named confirmationCode, which requires a double-quoted identifier.
--
-- Drop the old snake_case version first to avoid ambiguous overload.

drop function if exists public.lookup_reservation(text);

create or replace function public.lookup_reservation("confirmationCode" text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
      'confirmation_code', r.confirmation_code,
      'guest_name', r.guest_name,
      'listing_title', l.title,
      'city', l.city,
      'host_name', l.host_name,
      'checkin_date', r.checkin_date,
      'checkout_date', r.checkout_date,
      'cancelled_date', r.cancelled_date,
      'nights', r.nights,
      'total_paid', r.total_paid,
      'status', r.status,
      'policy_type', l.policy_type,
      'policy_description', p.description,
      'refund_matrix', p.refund_matrix,
      'days_before_checkin_when_cancelled',
        case when r.cancelled_date is null then null
             else (r.checkin_date - r.cancelled_date) end
    )
    from reservations r
    join listings l on l.id = r.listing_id
    join cancellation_policies p on p.type = l.policy_type
    where r.confirmation_code = "confirmationCode"),
    jsonb_build_object('error', 'reservation_not_found', 'confirmation_code', "confirmationCode")
  );
$$;

grant execute on function public.lookup_reservation("confirmationCode" text) to anon;
