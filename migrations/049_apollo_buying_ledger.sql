-- Canonical source migration for the shared Apollo Buying Ledger.
-- Applied to Supabase as migration: apollo_buying_ledger.

create table if not exists public.apollo_supplier_sku_settings (
  id uuid primary key default gen_random_uuid(), supplier text not null default '', sku text not null,
  lead_time_days integer, moq numeric(14,3), pack_size numeric(14,3),
  target_cover_months numeric(8,3) not null default 3, notes text not null default '',
  created_by text not null default 'apollo', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint apollo_supplier_sku_settings_sku_check check (btrim(sku) <> ''),
  constraint apollo_supplier_sku_settings_lead_time_check check (lead_time_days is null or lead_time_days between 0 and 365),
  constraint apollo_supplier_sku_settings_moq_check check (moq is null or moq >= 0),
  constraint apollo_supplier_sku_settings_pack_check check (pack_size is null or pack_size > 0),
  constraint apollo_supplier_sku_settings_cover_check check (target_cover_months between 0.5 and 24),
  constraint apollo_supplier_sku_settings_unique unique (supplier, sku)
);

create table if not exists public.apollo_incoming_shipments (
  id uuid primary key default gen_random_uuid(), shipment_ref text not null unique,
  method text not null, supplier text not null default '', eta date not null, original_eta date,
  status text not null default 'Ordered', landed_date date, notes text not null default '', source_file text not null default 'admin',
  created_by text not null default 'apollo', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint apollo_incoming_shipments_ref_check check (btrim(shipment_ref) <> ''),
  constraint apollo_incoming_shipments_method_check check (method in ('Container', 'Air')),
  constraint apollo_incoming_shipments_status_check check (status in ('Ordered','Departed','On the water','Customs','Landed — awaiting GRV','Partially received','Received','Cancelled')),
  constraint apollo_incoming_shipments_landed_check check (status <> 'Landed — awaiting GRV' or landed_date is not null)
);

create table if not exists public.apollo_incoming_shipment_lines (
  id uuid primary key default gen_random_uuid(), shipment_id uuid not null references public.apollo_incoming_shipments(id) on delete cascade,
  sku text not null, description text not null default '', quantity numeric(14,3) not null, created_at timestamptz not null default now(),
  constraint apollo_incoming_shipment_lines_sku_check check (btrim(sku) <> ''),
  constraint apollo_incoming_shipment_lines_quantity_check check (quantity > 0),
  constraint apollo_incoming_shipment_lines_unique unique (shipment_id, sku)
);

create table if not exists public.apollo_incoming_receipts (
  id uuid primary key default gen_random_uuid(), shipment_id uuid not null references public.apollo_incoming_shipments(id) on delete cascade,
  receipt_ref text not null, received_date date not null, sku text not null, quantity numeric(14,3) not null,
  notes text not null default '', created_by text not null default 'apollo', created_at timestamptz not null default now(),
  constraint apollo_incoming_receipts_ref_check check (btrim(receipt_ref) <> ''),
  constraint apollo_incoming_receipts_sku_check check (btrim(sku) <> ''),
  constraint apollo_incoming_receipts_quantity_check check (quantity > 0),
  constraint apollo_incoming_receipts_unique unique (shipment_id, receipt_ref, sku)
);

create index if not exists apollo_supplier_sku_settings_sku_idx on public.apollo_supplier_sku_settings (sku, updated_at desc);
create index if not exists apollo_incoming_shipments_eta_idx on public.apollo_incoming_shipments (eta) where status not in ('Received', 'Cancelled');
create index if not exists apollo_incoming_shipment_lines_sku_idx on public.apollo_incoming_shipment_lines (sku);
create index if not exists apollo_incoming_receipts_shipment_sku_idx on public.apollo_incoming_receipts (shipment_id, sku);

alter table public.apollo_supplier_sku_settings enable row level security;
alter table public.apollo_incoming_shipments enable row level security;
alter table public.apollo_incoming_shipment_lines enable row level security;
alter table public.apollo_incoming_receipts enable row level security;
revoke all on public.apollo_supplier_sku_settings from anon, authenticated;
revoke all on public.apollo_incoming_shipments from anon, authenticated;
revoke all on public.apollo_incoming_shipment_lines from anon, authenticated;
revoke all on public.apollo_incoming_receipts from anon, authenticated;
grant select, insert, update, delete on public.apollo_supplier_sku_settings to service_role;
grant select, insert, update, delete on public.apollo_incoming_shipments to service_role;
grant select, insert, update, delete on public.apollo_incoming_shipment_lines to service_role;
grant select, insert, update, delete on public.apollo_incoming_receipts to service_role;
