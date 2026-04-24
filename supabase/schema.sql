-- Airbnb Agent Training Demo — schema
-- Run in Supabase SQL editor. Idempotent.

create extension if not exists "pgcrypto";

-- Core domain ---------------------------------------------------------------

create table if not exists cancellation_policies (
  type text primary key,
  description text not null,
  refund_matrix jsonb not null
);

create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  city text not null,
  host_name text not null,
  nightly_rate numeric(10,2) not null,
  policy_type text not null references cancellation_policies(type),
  created_at timestamptz not null default now()
);

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  confirmation_code text unique not null,
  guest_name text not null,
  listing_id uuid not null references listings(id) on delete cascade,
  checkin_date date not null,
  checkout_date date not null,
  cancelled_date date,
  nights int not null,
  total_paid numeric(10,2) not null,
  status text not null default 'active' check (status in ('active','cancelled','completed')),
  created_at timestamptz not null default now()
);

-- Training layer ------------------------------------------------------------

create table if not exists training_scenarios (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  customer_persona text not null,
  scenario_prompt text not null,
  kb_refs text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists evaluations (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references training_scenarios(id) on delete cascade,
  trainee_name text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript jsonb not null default '[]'::jsonb,
  policy_score int check (policy_score between 0 and 10),
  tool_calls jsonb not null default '[]'::jsonb,
  empathy_flags jsonb not null default '[]'::jsonb,
  escalation_flag boolean not null default false
);

create table if not exists coaching_notes (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references evaluations(id) on delete cascade,
  flag_type text not null,
  timestamp_in_call numeric,
  note text not null,
  severity text not null check (severity in ('info','warn','miss')),
  created_at timestamptz not null default now()
);

-- Indexes -------------------------------------------------------------------

create index if not exists idx_reservations_confirmation on reservations(confirmation_code);
create index if not exists idx_evaluations_scenario on evaluations(scenario_id);
create index if not exists idx_coaching_notes_eval on coaching_notes(evaluation_id);

-- RLS -----------------------------------------------------------------------
-- Demo posture: anon key can read everything needed for the portal.
-- Writes to evaluations + coaching_notes come from the edge function using
-- the service-role key (bypasses RLS).

alter table listings enable row level security;
alter table cancellation_policies enable row level security;
alter table reservations enable row level security;
alter table training_scenarios enable row level security;
alter table evaluations enable row level security;
alter table coaching_notes enable row level security;

create policy "anon read listings" on listings for select to anon using (true);
create policy "anon read policies" on cancellation_policies for select to anon using (true);
create policy "anon read reservations" on reservations for select to anon using (true);
create policy "anon read scenarios" on training_scenarios for select to anon using (true);
create policy "anon read evaluations" on evaluations for select to anon using (true);
create policy "anon read coaching" on coaching_notes for select to anon using (true);

-- RPC used as the ElevenLabs tool endpoint -----------------------------------
-- lookup_reservation returns the joined view the agent needs in one call.

create or replace function lookup_reservation(confirmation_code text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
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
  where r.confirmation_code = lookup_reservation.confirmation_code;
$$;

grant execute on function lookup_reservation(text) to anon;
