-- Airbnb Agent Training Demo — seed data
-- Run after schema.sql.

-- Cancellation policies -----------------------------------------------------

insert into cancellation_policies (type, description, refund_matrix) values
  ('Firm',
   'Full refund if cancelled 30+ days before check-in. 50% refund (excluding fees) if cancelled at least 7 days before check-in. No refund after that.',
   jsonb_build_object(
     'gte_30_days', 1.00,
     'gte_7_days', 0.50,
     'lt_7_days', 0.00,
     'service_fee_refundable_first_cancellation_within_48h', true
   )),
  ('Flexible',
   'Full refund up to 24 hours before check-in.',
   jsonb_build_object('gte_1_day', 1.00, 'lt_1_day', 0.00)),
  ('Strict',
   'Full refund if cancelled within 48 hours of booking AND 14+ days before check-in. 50% refund up to 7 days before check-in. No refund after.',
   jsonb_build_object('within_48h_and_gte_14_days', 1.00, 'gte_7_days', 0.50, 'lt_7_days', 0.00))
on conflict (type) do nothing;

-- Listings ------------------------------------------------------------------

insert into listings (id, title, city, host_name, nightly_rate, policy_type) values
  ('11111111-1111-1111-1111-111111111111',
   'Waterfront Villa with Fire Pit',
   'Prince Edward County, ON',
   'Daniel O.',
   487.50,
   'Firm')
on conflict (id) do nothing;

-- Reservations --------------------------------------------------------------
-- The star of the demo: HMXYZ8423
-- Cancelled 5 days before check-in on a Firm policy = 0% refund per matrix.
-- Customer expects full, trainee must apply policy while offering AirCover path.

insert into reservations
  (id, confirmation_code, guest_name, listing_id, checkin_date, checkout_date, cancelled_date, nights, total_paid, status)
values
  ('22222222-2222-2222-2222-222222222222',
   'HMXYZ8423',
   'Sarah Chen',
   '11111111-1111-1111-1111-111111111111',
   '2026-05-08',
   '2026-05-12',
   '2026-05-03',
   4,
   2145.00,
   'cancelled')
on conflict (confirmation_code) do nothing;

-- Training scenarios --------------------------------------------------------

insert into training_scenarios (id, title, customer_persona, scenario_prompt, kb_refs) values
  ('33333333-3333-3333-3333-333333333333',
   'Cancellation dispute — Firm policy, 5 days out',
   'Sarah Chen, 34, marketing manager. Booked anniversary trip. Partner got flu 5 days before check-in. Cancelled, expects full refund. Did not buy AirCover. Articulate, escalates if dismissed, softens if acknowledged. Threatens chargeback if refund flatly refused.',
   'The trainee must: (1) lookup reservation HMXYZ8423, (2) acknowledge emotional context before quoting policy, (3) explain Firm policy applies and 5-day cancellation yields 0 percent refund, (4) offer AirCover extenuating-circumstances review for documented illness as the path forward, (5) escalate to supervisor if customer mentions legal action or chargeback.',
   array['firm-policy-kb.md'])
on conflict (id) do nothing;

-- Fake prior trainee runs for the facilitator dashboard --------------------
-- These populate the dashboard tab so Max can show aggregate view.

insert into evaluations
  (id, scenario_id, trainee_name, started_at, ended_at, policy_score, tool_calls, empathy_flags, escalation_flag)
values
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
   'Maya R. (Atlanta, in-house)', now() - interval '3 hours', now() - interval '3 hours' + interval '6 minutes',
   8,
   jsonb_build_array(jsonb_build_object('tool','lookup_reservation','at_seconds',12,'ok',true)),
   jsonb_build_array(jsonb_build_object('flag','strong_acknowledgement','at_seconds',4)),
   true),
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
   'Marcus D. (Atlanta, in-house)', now() - interval '1 day',  now() - interval '1 day' + interval '5 minutes',
   6,
   jsonb_build_array(jsonb_build_object('tool','lookup_reservation','at_seconds',45,'ok',true)),
   jsonb_build_array(jsonb_build_object('flag','tone_shift_too_fast','at_seconds',90)),
   false),
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
   'Elena V. (Portland, in-house)', now() - interval '1 day 2 hours', now() - interval '1 day 2 hours' + interval '7 minutes',
   9,
   jsonb_build_array(jsonb_build_object('tool','lookup_reservation','at_seconds',9,'ok',true)),
   jsonb_build_array(
     jsonb_build_object('flag','strong_acknowledgement','at_seconds',6),
     jsonb_build_object('flag','aircover_path_offered','at_seconds',140)),
   true),
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
   'Jordan B. (Portland, in-house)', now() - interval '2 days', now() - interval '2 days' + interval '8 minutes',
   5,
   jsonb_build_array(),
   jsonb_build_array(jsonb_build_object('flag','missed_emotional_context','at_seconds',3)),
   false),
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
   'Ade O. (San Francisco, in-house)', now() - interval '3 days', now() - interval '3 days' + interval '5 minutes',
   7,
   jsonb_build_array(jsonb_build_object('tool','lookup_reservation','at_seconds',20,'ok',true)),
   jsonb_build_array(jsonb_build_object('flag','policy_cited_correctly','at_seconds',110)),
   true)
on conflict do nothing;
