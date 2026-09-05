-- Image generation cost logs + per-SKU slot locks (stock Supabase).
-- Run against the same DB as website_stock / archived_products.

create table if not exists public.image_gen_cost_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sku text,
  slot smallint,
  operation text not null default 'transform',
  model text,
  image_style text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  cost_zar numeric(12, 4) not null default 0,
  processing_ms integer,
  operator text,
  batch_id text,
  status text not null default 'ok',
  error text
);

create index if not exists image_gen_cost_logs_created_at_idx
  on public.image_gen_cost_logs (created_at desc);

create index if not exists image_gen_cost_logs_batch_id_idx
  on public.image_gen_cost_logs (batch_id)
  where batch_id is not null;

create table if not exists public.image_gen_batches (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  operator text,
  status text not null default 'running',
  total integer not null default 0,
  done integer not null default 0,
  failed integer not null default 0,
  style text,
  product_count integer not null default 0,
  finished_at timestamptz
);

create index if not exists image_gen_batches_status_idx
  on public.image_gen_batches (status, updated_at desc);

create table if not exists public.image_gen_locks (
  sku text not null,
  slot smallint not null,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  batch_id text,
  operator text,
  primary key (sku, slot)
);

create index if not exists image_gen_locks_expires_at_idx
  on public.image_gen_locks (expires_at);

alter table public.image_gen_cost_logs enable row level security;
alter table public.image_gen_batches enable row level security;
alter table public.image_gen_locks enable row level security;
