-- 068_instore_image_controls (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- A misleading Instore image must be removable without changing the product's
-- ERP-backed price, stock, ordering eligibility or catalogue classification.
-- These controls are private to owner-authorized server routes. The original
-- product image remains untouched and is restored by setting status to visible.

create table if not exists public.instore_image_controls (
  sku text primary key,
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  original_image_url text,
  reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.instore_image_control_events (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  previous_status text not null check (previous_status in ('visible', 'hidden')),
  next_status text not null check (next_status in ('visible', 'hidden')),
  reason text,
  actor text,
  original_image_url text,
  created_at timestamptz not null default now()
);

create index if not exists instore_image_control_events_sku_created_idx
  on public.instore_image_control_events (sku, created_at desc);

alter table public.instore_image_controls enable row level security;
alter table public.instore_image_control_events enable row level security;

revoke all on public.instore_image_controls from anon, authenticated;
revoke all on public.instore_image_control_events from anon, authenticated;
grant all on public.instore_image_controls to service_role;
grant all on public.instore_image_control_events to service_role;

create or replace function public.set_instore_image_control(
  p_sku text,
  p_status text,
  p_reason text default null,
  p_actor text default null,
  p_original_image_url text default null
)
returns public.instore_image_controls
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_status text := 'visible';
  result public.instore_image_controls;
begin
  if coalesce(trim(p_sku), '') = '' then
    raise exception 'SKU is required';
  end if;
  if p_status not in ('visible', 'hidden') then
    raise exception 'Invalid Instore image status';
  end if;

  select status into current_status
  from public.instore_image_controls
  where sku = upper(trim(p_sku));
  current_status := coalesce(current_status, 'visible');

  insert into public.instore_image_controls (sku, status, original_image_url, reason, updated_by, updated_at)
  values (
    upper(trim(p_sku)), p_status,
    nullif(trim(p_original_image_url), ''),
    nullif(trim(p_reason), ''),
    nullif(trim(p_actor), ''), now()
  )
  on conflict (sku) do update set
    status = excluded.status,
    original_image_url = coalesce(public.instore_image_controls.original_image_url, excluded.original_image_url),
    reason = excluded.reason,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  returning * into result;

  insert into public.instore_image_control_events (
    sku, previous_status, next_status, reason, actor, original_image_url
  ) values (
    result.sku, current_status, result.status, result.reason, result.updated_by, result.original_image_url
  );

  return result;
end;
$$;

revoke all on function public.set_instore_image_control(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_instore_image_control(text, text, text, text, text) to service_role;
