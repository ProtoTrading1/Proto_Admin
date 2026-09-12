-- 069_instore_listing_controls (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- This is deliberately separate from image controls. It removes an exact SKU
-- from the Instore storefront and checkout path while preserving the source
-- item, ERP-backed price/stock, image asset and main-catalogue records.

create table if not exists public.instore_listing_controls (
  sku text primary key,
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.instore_listing_control_events (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  previous_status text not null check (previous_status in ('visible', 'hidden')),
  next_status text not null check (next_status in ('visible', 'hidden')),
  reason text,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists instore_listing_control_events_sku_created_idx
  on public.instore_listing_control_events (sku, created_at desc);

alter table public.instore_listing_controls enable row level security;
alter table public.instore_listing_control_events enable row level security;

revoke all on public.instore_listing_controls from anon, authenticated;
revoke all on public.instore_listing_control_events from anon, authenticated;
grant all on public.instore_listing_controls to service_role;
grant all on public.instore_listing_control_events to service_role;

create or replace function public.set_instore_listing_control(
  p_sku text,
  p_status text,
  p_reason text default null,
  p_actor text default null
)
returns public.instore_listing_controls
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_status text := 'visible';
  result public.instore_listing_controls;
begin
  if coalesce(trim(p_sku), '') = '' then
    raise exception 'SKU is required';
  end if;
  if p_status not in ('visible', 'hidden') then
    raise exception 'Invalid Instore listing status';
  end if;

  select status into current_status
  from public.instore_listing_controls
  where sku = upper(trim(p_sku));
  current_status := coalesce(current_status, 'visible');

  insert into public.instore_listing_controls (sku, status, reason, updated_by, updated_at)
  values (upper(trim(p_sku)), p_status, nullif(trim(p_reason), ''), nullif(trim(p_actor), ''), now())
  on conflict (sku) do update set
    status = excluded.status,
    reason = excluded.reason,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  returning * into result;

  insert into public.instore_listing_control_events (sku, previous_status, next_status, reason, actor)
  values (result.sku, current_status, result.status, result.reason, result.updated_by);

  return result;
end;
$$;

revoke all on function public.set_instore_listing_control(text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_instore_listing_control(text, text, text, text) to service_role;
