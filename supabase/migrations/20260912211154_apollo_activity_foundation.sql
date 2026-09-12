-- Apollo-only additive foundation. Feature switches remain OFF.
-- No changes to orders, prices, existing analytics, stock or customer accounts.
-- The authenticated server derives customer_id; browsers have no table access.
begin;
create table public.apollo_activity_events (
  event_id uuid primary key,
  customer_id uuid not null,
  session_id uuid not null,
  source text not null check (source in ('main', 'instore')),
  event_type text not null check (event_type in
    ('search_completed', 'product_view', 'category_view', 'cart_item_added', 'active_interval')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  check (occurred_at <= received_at + interval '2 minutes'),
  check (occurred_at >= received_at - interval '1 day')
);
create index apollo_activity_period_idx on public.apollo_activity_events (occurred_at, event_id);
create index apollo_activity_customer_period_idx on public.apollo_activity_events (customer_id, occurred_at);
alter table public.apollo_activity_events enable row level security;
revoke all on public.apollo_activity_events from public, anon, authenticated;
grant select, insert, delete on public.apollo_activity_events to service_role;
-- INSERT ... ON CONFLICT DO NOTHING preserves event identity without overwrites.

-- Coverage is an explicitly monitored feed, never inferred from an empty table.
create table public.apollo_collection_health (
  source text primary key check (source in ('main', 'instore')),
  collection_started_at timestamptz not null,
  last_successful_at timestamptz,
  complete_since timestamptz,
  last_failure_at timestamptz,
  check (last_successful_at is null or last_successful_at >= collection_started_at),
  check (complete_since is null or complete_since >= collection_started_at)
);
alter table public.apollo_collection_health enable row level security;
revoke all on public.apollo_collection_health from public, anon, authenticated;
grant select, insert, update on public.apollo_collection_health to service_role;

-- Non-identifying counts only: no customer/session IDs, free-text searches, or payloads.
-- Retention executor must be tested before collection is enabled.
create table public.apollo_activity_monthly (
  month date not null check (extract(day from month) = 1),
  source text not null check (source in ('main', 'instore')),
  event_type text not null check (event_type in
    ('search_completed', 'product_view', 'category_view', 'cart_item_added', 'active_interval')),
  event_count bigint not null check (event_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (month, source, event_type)
);
alter table public.apollo_activity_monthly enable row level security;
revoke all on public.apollo_activity_monthly from public, anon, authenticated;
grant select, insert, update, delete on public.apollo_activity_monthly to service_role;
commit;
