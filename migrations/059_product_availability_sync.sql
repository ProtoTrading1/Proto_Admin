-- One private availability record per website SKU. This supplements ERP stock
-- with container status without pretending un-GRV'd quantities are on hand.
-- The existing website_stock.to_order flag remains the separate source of truth
-- for made-to-order / supplier-sourced products.

create table if not exists public.website_product_availability (
  sku text primary key,
  incoming_status text not null default 'none',
  incoming_qty numeric(14,3) not null default 0,
  incoming_eta date,
  shipment_ref text not null default '',
  allow_preorder boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'admin',
  constraint website_product_availability_sku_check check (btrim(sku) <> ''),
  constraint website_product_availability_status_check check (
    incoming_status in ('none', 'on_the_way', 'customs', 'landed_awaiting_grv', 'partially_received')
  ),
  constraint website_product_availability_qty_check check (incoming_qty >= 0),
  constraint website_product_availability_none_check check (
    incoming_status <> 'none'
    or (incoming_qty = 0 and incoming_eta is null and allow_preorder = false)
  ),
  constraint website_product_availability_active_qty_check check (
    incoming_status = 'none' or incoming_qty > 0
  )
);

create index if not exists website_product_availability_status_idx
  on public.website_product_availability (incoming_status, incoming_eta)
  where incoming_status <> 'none';

alter table public.website_product_availability enable row level security;
revoke all on table public.website_product_availability from public, anon, authenticated;
grant select, insert, update, delete on table public.website_product_availability to service_role;

-- Customer-facing APIs use the catalogue project's existing public key. Give
-- them only a deliberately narrow projection: shipment_ref and updated_by are
-- never returned, and the underlying table remains inaccessible.
create or replace function public.get_website_product_availability(p_skus text[] default null)
returns table (
  sku text,
  incoming_status text,
  incoming_qty numeric,
  incoming_eta date,
  allow_preorder boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.sku,
    a.incoming_status,
    a.incoming_qty,
    a.incoming_eta,
    a.allow_preorder
  from public.website_product_availability a
  where p_skus is null or a.sku = any(p_skus);
$$;

create or replace function public.get_website_product_availability_version()
returns table (newest_updated_at timestamptz, row_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select max(a.updated_at), count(*)
  from public.website_product_availability a;
$$;

revoke all on function public.get_website_product_availability(text[]) from public;
revoke all on function public.get_website_product_availability_version() from public;
grant execute on function public.get_website_product_availability(text[]) to anon, authenticated, service_role;
grant execute on function public.get_website_product_availability_version() to anon, authenticated, service_role;

-- Reconcile landed quantities against subsequent ERP stock increases. A
-- partial GRV reduces the outstanding incoming balance; a complete GRV removes
-- the temporary arrival state so it can never reappear after a later sell-out.
create or replace function public.reconcile_website_product_availability_after_grv()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_qty numeric := coalesce(old.available_stock, old.stock_qty, 0);
  new_qty numeric := coalesce(new.available_stock, new.stock_qty, 0);
  received_qty numeric;
  outstanding_qty numeric;
begin
  received_qty := greatest(new_qty - old_qty, 0);
  if received_qty <= 0 then
    return new;
  end if;

  select a.incoming_qty
    into outstanding_qty
    from public.website_product_availability a
   where a.sku = new.sku
     and a.incoming_status in ('landed_awaiting_grv', 'partially_received')
   for update;

  if outstanding_qty is null then
    return new;
  end if;

  if outstanding_qty <= received_qty then
    delete from public.website_product_availability where sku = new.sku;
  else
    update public.website_product_availability
       set incoming_status = 'partially_received',
           incoming_qty = outstanding_qty - received_qty,
           updated_at = now(),
           updated_by = 'erp-grv-sync'
     where sku = new.sku;
  end if;

  return new;
end;
$$;

drop trigger if exists website_stock_reconcile_availability_after_grv on public.website_stock;
create trigger website_stock_reconcile_availability_after_grv
  after update of stock_qty, available_stock on public.website_stock
  for each row
  execute function public.reconcile_website_product_availability_after_grv();

revoke all on function public.reconcile_website_product_availability_after_grv() from public, anon, authenticated;

comment on table public.website_product_availability is
  'Private per-SKU incoming stock state. ERP stock remains authoritative stock on hand; to_order remains the made/sourced-on-request flag.';

comment on function public.get_website_product_availability(text[]) is
  'Customer-safe availability projection. Deliberately excludes internal shipment reference and audit fields.';
