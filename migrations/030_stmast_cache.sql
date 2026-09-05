create table if not exists public.stmast_cache (
  code        text primary key,
  descr       text,
  price_a     numeric(12,3),
  onhand      numeric(12,3),
  booked      numeric(12,3),
  dept        text,
  supplier    text,
  barcode     text,
  imported_at timestamptz not null default now()
);

create index if not exists stmast_cache_barcode_idx
  on public.stmast_cache (barcode)
  where barcode is not null and barcode != '';

alter table public.stmast_cache enable row level security;
revoke all on public.stmast_cache from anon, authenticated;
grant all on public.stmast_cache to service_role;
