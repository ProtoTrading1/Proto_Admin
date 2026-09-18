-- 070_instore_admin_image_slots
--
-- Additional source images for a private Instore review item.  The primary
-- thumbnail remains instore_admin_items.image_path; this table keeps the
-- numbered source files without ever altering a website/catalogue record.

create table if not exists public.instore_admin_item_images (
  sku text not null references public.instore_admin_items(sku) on delete cascade,
  image_slot smallint not null check (image_slot between 1 and 4),
  image_path text not null,
  content_digest text not null check (content_digest ~ '^[a-f0-9]{20}$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/jpg', 'image/png', 'image/webp')),
  filename text not null,
  batch_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (sku, image_slot),
  unique (image_path),
  unique (sku, image_slot, content_digest)
);

create index if not exists instore_admin_item_images_sku_created_idx
  on public.instore_admin_item_images (sku, created_at);

alter table public.instore_admin_item_images enable row level security;
revoke all on public.instore_admin_item_images from anon, authenticated;
grant select, insert, update, delete on public.instore_admin_item_images to service_role;
