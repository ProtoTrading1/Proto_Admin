-- 069a_instore_admin_base
--
-- Private review overlay for Instore product intake. This migration deliberately
-- creates no customer-facing catalogue records and grants no browser role access.
-- It is safe to re-run: the queue, audit log, indexes, private bucket and the
-- transition RPC are all created or replaced deterministically.
--
-- Apply this before 070_instore_admin_image_slots.sql. Image slots live in the
-- following migration so that image-file changes remain independently reviewable.

create table if not exists public.instore_admin_items (
  sku text primary key,
  title text not null default '',
  category text not null default '',
  units_of_issue text,
  price_ex_vat numeric,
  price_incl_vat numeric,
  recorded_stock numeric,
  confirmed_qty bigint,
  status text not null default 'archived',
  availability_mode text not null default 'positill',
  batch_id uuid not null,
  filename text not null,
  image_path text not null,
  review_error text,
  snapshot jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  constraint instore_admin_items_sku_check
    check (sku ~ '^[A-Z0-9][A-Z0-9._-]{1,63}$'),
  constraint instore_admin_items_price_ex_vat_check
    check (price_ex_vat is null or price_ex_vat >= 0),
  constraint instore_admin_items_price_incl_vat_check
    check (price_incl_vat is null or price_incl_vat >= 0),
  constraint instore_admin_items_recorded_stock_check
    check (recorded_stock is null or recorded_stock >= 0),
  constraint instore_admin_items_confirmed_qty_check
    check (confirmed_qty >= 1 and confirmed_qty <= 1000000000),
  constraint instore_admin_items_status_check
    check (status in ('archived', 'live', 'recycle')),
  constraint instore_admin_items_availability_mode_check
    check (availability_mode in ('positill', 'stock_available', 'to_order')),
  constraint instore_admin_items_check
    check (
      (availability_mode = 'stock_available' and confirmed_qty is not null)
      or (availability_mode <> 'stock_available' and confirmed_qty is null)
    ),
  constraint instore_admin_items_version_check check (version > 0)
);

create table if not exists public.instore_admin_item_events (
  id uuid primary key default gen_random_uuid(),
  sku text not null references public.instore_admin_items(sku),
  action text not null,
  actor text not null,
  before_state jsonb,
  after_state jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists instore_admin_status_updated
  on public.instore_admin_items (status, updated_at desc, sku);
create index if not exists instore_admin_events_sku
  on public.instore_admin_item_events (sku, created_at desc);

-- The bucket is intentionally private. It accepts only the bounded image types
-- validated by the server route. No public or authenticated policy is created:
-- server-only service-role calls perform signed-URL reads and intake writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'instore-intake',
  'instore-intake',
  false,
  2097152,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.instore_admin_items enable row level security;
alter table public.instore_admin_item_events enable row level security;

-- The Data API must never expose this private operational queue. The server
-- uses a service-role key stored only in deployment configuration.
revoke all on public.instore_admin_items from anon, authenticated;
revoke all on public.instore_admin_item_events from anon, authenticated;
grant select, insert, update on public.instore_admin_items to service_role;
grant select, insert on public.instore_admin_item_events to service_role;

create or replace function public.instore_admin_transition(
  p_sku text,
  p_expected_version integer,
  p_action text,
  p_actor text,
  p_patch jsonb
)
returns public.instore_admin_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  before_row public.instore_admin_items;
  after_row public.instore_admin_items;
  incoming public.instore_admin_items;
begin
  if p_actor is null or length(trim(p_actor)) = 0
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Actor and object patch required' using errcode = '22023';
  end if;

  -- Customer-site publication is fail-closed until a separately reviewed
  -- storefront contract is introduced.
  if p_action in ('approve', 'publish') then
    raise exception 'Instore publish integration pending' using errcode = '55000';
  end if;
  if p_action not in ('stage', 'update', 'sync', 'archive', 'recycle', 'restore') then
    raise exception 'Unsupported action' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sku, 0));
  select * into before_row
  from public.instore_admin_items
  where sku = p_sku
  for update;

  if p_action = 'stage' then
    if found then
      return before_row;
    end if;
    incoming := jsonb_populate_record(null::public.instore_admin_items, p_patch);
    insert into public.instore_admin_items (
      sku, title, category, units_of_issue, price_ex_vat, price_incl_vat,
      recorded_stock, confirmed_qty, status, availability_mode, batch_id,
      filename, image_path, review_error, snapshot, updated_by
    ) values (
      p_sku, coalesce(incoming.title, ''), coalesce(incoming.category, ''),
      incoming.units_of_issue, incoming.price_ex_vat, incoming.price_incl_vat,
      incoming.recorded_stock, null, 'archived', 'positill', incoming.batch_id,
      incoming.filename, incoming.image_path, incoming.review_error,
      coalesce(incoming.snapshot, '{}'::jsonb), p_actor
    ) returning * into after_row;
  else
    if not found then
      raise exception 'Instore SKU not found' using errcode = 'P0002';
    end if;
    if p_expected_version is null or p_expected_version <> before_row.version then
      raise exception 'stale_version' using errcode = '40001';
    end if;
    if before_row.status = 'live' and p_action in ('update', 'sync') then
      raise exception 'Archive before editing live listing' using errcode = '55000';
    end if;
    if p_action = 'restore' and before_row.status <> 'recycle' then
      raise exception 'Only recycled rows can be restored' using errcode = '22023';
    end if;
    if p_action in ('update', 'sync') and before_row.status = 'recycle' then
      raise exception 'Restore before editing' using errcode = '55000';
    end if;

    incoming := jsonb_populate_record(before_row, p_patch);
    if p_action = 'update' then
      update public.instore_admin_items set
        title = incoming.title,
        category = incoming.category,
        availability_mode = incoming.availability_mode,
        confirmed_qty = incoming.confirmed_qty,
        review_error = 'review_required',
        version = version + 1,
        updated_at = now(),
        updated_by = p_actor
      where sku = p_sku
      returning * into after_row;
    elsif p_action = 'sync' then
      update public.instore_admin_items set
        title = incoming.title,
        units_of_issue = incoming.units_of_issue,
        price_ex_vat = incoming.price_ex_vat,
        price_incl_vat = incoming.price_incl_vat,
        recorded_stock = incoming.recorded_stock,
        review_error = incoming.review_error,
        snapshot = incoming.snapshot,
        version = version + 1,
        updated_at = now(),
        updated_by = p_actor
      where sku = p_sku
      returning * into after_row;
    else
      update public.instore_admin_items set
        status = case when p_action = 'recycle' then 'recycle' else 'archived' end,
        version = version + 1,
        updated_at = now(),
        updated_by = p_actor
      where sku = p_sku
      returning * into after_row;
    end if;
  end if;

  insert into public.instore_admin_item_events (
    sku, action, actor, before_state, after_state
  ) values (
    p_sku,
    p_action,
    p_actor,
    case when before_row.sku is null then null else to_jsonb(before_row) end,
    to_jsonb(after_row)
  );
  return after_row;
end;
$$;

revoke all on function public.instore_admin_transition(text, integer, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.instore_admin_transition(text, integer, text, text, jsonb)
  to service_role;
