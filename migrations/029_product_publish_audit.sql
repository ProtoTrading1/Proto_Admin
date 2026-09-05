-- 029_product_publish_audit.sql  (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- Audit log for every manual product publish via the Product Loader.
-- old_values captures the full existing row before change (null for creates).
-- new_values captures only the fields written in this publish operation.

create table if not exists public.product_publish_audit (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null,
  action         text not null check (action in ('create', 'update')),
  source         text not null default 'manual_product_loader',
  publish_mode   text not null default 'direct',
  image_slot     smallint check (image_slot between 1 and 4),
  image_source   text,
  category_confidence numeric(4,3),
  old_values     jsonb,
  new_values     jsonb,
  published_by   text,
  published_at   timestamptz not null default now()
);

create index if not exists product_publish_audit_sku_idx
  on public.product_publish_audit (sku);

create index if not exists product_publish_audit_published_at_idx
  on public.product_publish_audit (published_at desc);

alter table public.product_publish_audit enable row level security;

revoke all on public.product_publish_audit from anon, authenticated;
grant all on public.product_publish_audit to service_role;
