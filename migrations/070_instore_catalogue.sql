-- 070_instore_catalogue (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- Instore Products was rebuilt from the Positill-backed source index on every
-- customer request: a complete paged read of extended_range_items, a complete
-- paged read of website_stock for the duplicate gate, then the image, price,
-- stock and classification rules in JavaScript. That is thousands of rows of
-- work before the first of sixty products can be shown.
--
-- These tables hold the already-gated result so a browse or search request
-- reads one small page instead of the whole source index. This is a cache of a
-- decision, never a source of truth: the eligibility rules, prices, stock
-- figures and the checkout verification are unchanged, and nothing reads these
-- tables when the snapshot is missing, stale, or built under different Instore
-- image/listing controls than the ones currently in force.

create table if not exists public.instore_catalogue (
  sku text primary key,
  -- Position in the default (no search term) customer ordering, so the
  -- landing page and category pages can be ordered and paged by the database.
  sort_index integer not null,
  -- Browse category from the shared classifier, stored so a category filter
  -- does not have to re-classify the whole collection.
  discovery_group text not null,
  -- Space-delimited, space-padded search tokens for the same prefix rule the
  -- application applies. ' bracelet wooden bead ' matches LIKE '% wood%'.
  search_tokens text not null,
  -- The exact product object the customer API returns for this SKU.
  payload jsonb not null,
  refreshed_at timestamptz not null default now()
);

create index if not exists instore_catalogue_sort_idx
  on public.instore_catalogue (sort_index);
create index if not exists instore_catalogue_group_sort_idx
  on public.instore_catalogue (discovery_group, sort_index);

-- A refresh stages its rows first and swaps them in one statement, so a
-- customer can never be served a half-written collection.
create table if not exists public.instore_catalogue_staging (
  batch_id uuid not null,
  sku text not null,
  sort_index integer not null,
  discovery_group text not null,
  search_tokens text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, sku)
);

create table if not exists public.instore_catalogue_state (
  id boolean primary key default true check (id),
  refreshed_at timestamptz,
  -- Held while one request or cron run rebuilds the snapshot, so concurrent
  -- traffic falls back to the live read instead of stampeding the rebuild.
  refreshing_at timestamptz,
  product_count integer not null default 0,
  -- Fingerprint of the Instore image/listing controls the snapshot was built
  -- under. A control change invalidates the snapshot immediately.
  controls_fingerprint text not null default '',
  -- Fingerprint of the staged rows, so an unchanged collection is revalidated
  -- without rewriting every row.
  payload_fingerprint text not null default '',
  -- Browse tiles for the complete collection, which do not depend on the
  -- current search, category or page.
  tiles jsonb not null default '[]'::jsonb,
  last_error text,
  updated_at timestamptz not null default now()
);

insert into public.instore_catalogue_state (id) values (true) on conflict (id) do nothing;

alter table public.instore_catalogue enable row level security;
alter table public.instore_catalogue_staging enable row level security;
alter table public.instore_catalogue_state enable row level security;

revoke all on public.instore_catalogue from anon, authenticated;
revoke all on public.instore_catalogue_staging from anon, authenticated;
revoke all on public.instore_catalogue_state from anon, authenticated;
grant all on public.instore_catalogue to service_role;
grant all on public.instore_catalogue_staging to service_role;
grant all on public.instore_catalogue_state to service_role;

-- Exactly one caller rebuilds a stale snapshot. Everything else keeps serving.
create or replace function public.instore_catalogue_claim_refresh(
  p_stale_before timestamptz,
  p_lease_seconds integer default 180
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  update public.instore_catalogue_state
  set refreshing_at = now(), updated_at = now()
  where id
    and (refreshed_at is null or refreshed_at < p_stale_before)
    and (refreshing_at is null
      or refreshing_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 180), 30)))
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.instore_catalogue_release_refresh(p_error text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.instore_catalogue_state
  set refreshing_at = null,
      last_error = nullif(left(coalesce(p_error, ''), 500), ''),
      updated_at = now()
  where id;
end;
$$;

create or replace function public.instore_catalogue_stage(p_batch uuid, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  staged integer := 0;
begin
  if p_batch is null then
    raise exception 'A staging batch id is required';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Instore catalogue rows must be a JSON array';
  end if;

  insert into public.instore_catalogue_staging (batch_id, sku, sort_index, discovery_group, search_tokens, payload)
  select
    p_batch,
    upper(trim(row_data->>'sku')),
    (row_data->>'sort_index')::integer,
    row_data->>'discovery_group',
    row_data->>'search_tokens',
    row_data->'payload'
  from jsonb_array_elements(p_rows) as row_data
  where coalesce(trim(row_data->>'sku'), '') <> ''
    and jsonb_typeof(row_data->'payload') = 'object'
  on conflict (batch_id, sku) do update set
    sort_index = excluded.sort_index,
    discovery_group = excluded.discovery_group,
    search_tokens = excluded.search_tokens,
    payload = excluded.payload;

  select count(*) into staged from public.instore_catalogue_staging where batch_id = p_batch;
  return staged;
end;
$$;

-- The swap is one transaction. An incomplete or empty staging batch is
-- rejected rather than published, because an empty Instore collection would
-- look to a customer like the range had been withdrawn.
create or replace function public.instore_catalogue_commit(
  p_batch uuid,
  p_tiles jsonb,
  p_controls_fingerprint text,
  p_payload_fingerprint text,
  p_expected_count integer
)
returns public.instore_catalogue_state
language plpgsql
security invoker
set search_path = public
as $$
declare
  staged integer := 0;
  live integer := 0;
  previous_payload text := '';
  result public.instore_catalogue_state;
begin
  if p_expected_count is null or p_expected_count <= 0 then
    raise exception 'Instore catalogue refresh produced no products';
  end if;
  if jsonb_typeof(p_tiles) <> 'array' then
    raise exception 'Instore catalogue tiles must be a JSON array';
  end if;

  select count(*) into staged from public.instore_catalogue_staging where batch_id = p_batch;
  if staged <> p_expected_count then
    raise exception 'Instore catalogue staging held % of % products', staged, p_expected_count;
  end if;

  select coalesce(payload_fingerprint, '') into previous_payload
  from public.instore_catalogue_state where id;
  select count(*) into live from public.instore_catalogue;

  -- An unchanged collection only needs its freshness confirming.
  if previous_payload = '' or previous_payload <> coalesce(p_payload_fingerprint, '') or live <> staged then
    delete from public.instore_catalogue;
    insert into public.instore_catalogue (sku, sort_index, discovery_group, search_tokens, payload, refreshed_at)
    select sku, sort_index, discovery_group, search_tokens, payload, now()
    from public.instore_catalogue_staging
    where batch_id = p_batch;
  end if;

  delete from public.instore_catalogue_staging
  where batch_id = p_batch or created_at < now() - interval '2 hours';

  update public.instore_catalogue_state
  set refreshed_at = now(),
      refreshing_at = null,
      product_count = staged,
      controls_fingerprint = coalesce(p_controls_fingerprint, ''),
      payload_fingerprint = coalesce(p_payload_fingerprint, ''),
      tiles = p_tiles,
      last_error = null,
      updated_at = now()
  where id
  returning * into result;

  return result;
end;
$$;

revoke all on function public.instore_catalogue_claim_refresh(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.instore_catalogue_release_refresh(text) from public, anon, authenticated;
revoke all on function public.instore_catalogue_stage(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.instore_catalogue_commit(uuid, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.instore_catalogue_claim_refresh(timestamptz, integer) to service_role;
grant execute on function public.instore_catalogue_release_refresh(text) to service_role;
grant execute on function public.instore_catalogue_stage(uuid, jsonb) to service_role;
grant execute on function public.instore_catalogue_commit(uuid, jsonb, text, text, integer) to service_role;
