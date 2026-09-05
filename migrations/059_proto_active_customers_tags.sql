-- Applied to production (Proto Trading Website).
--
-- Tags on a pre-registration contact, set per CSV upload alongside the group
-- label. text[] so a contact can carry several; GIN indexed so "everyone
-- tagged X" stays cheap as the list grows.

alter table public.proto_active_customers
  add column if not exists tags text[] not null default '{}'::text[];

create index if not exists proto_active_customers_tags_idx
  on public.proto_active_customers using gin (tags);

-- The 2026-08-04 upload is the 10000 club cohort.
update public.proto_active_customers
set tags = array['10000 club']
where import_batch = '2026-08-04 19:36 import'
  and tags = '{}'::text[];
