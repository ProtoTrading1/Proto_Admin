-- Stock project: search + filter indexes for paginated catalogue API

create extension if not exists pg_trgm;

create index if not exists website_stock_title_trgm_idx
  on public.website_stock using gin (title gin_trgm_ops);

create index if not exists website_stock_updated_at_idx
  on public.website_stock (updated_at desc);

create index if not exists archived_products_archived_by_idx
  on public.archived_products (archived_by);

create index if not exists archived_products_updated_at_idx
  on public.archived_products (updated_at desc);

create index if not exists archived_products_title_trgm_idx
  on public.archived_products using gin (title gin_trgm_ops);
