-- 071_instore_catalogue_commit_safeupdate (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- Fixes a bug in 070. The Supabase REST role (`authenticator`) preloads
-- `safeupdate`, which rejects an UPDATE or DELETE carrying no WHERE clause.
-- That applies to statements inside a function too, so the snapshot swap's
--
--     delete from public.instore_catalogue;
--
-- was rejected with "DELETE requires a WHERE clause" whenever the portal called
-- `instore_catalogue_commit` through the API, even though the same call
-- succeeded from a direct `postgres` connection, which has no such preload.
-- The effect was that the Instore snapshot could never be published: the portal
-- kept serving the correct products from its live read (the write failure is
-- handled and only releases the refresh lease) but never got any faster.
--
-- `sku` is the primary key and therefore never null, so `where sku is not null`
-- matches every row and satisfies the guard. Nothing else about the function
-- changes: the swap is still one transaction, an incomplete or empty batch is
-- still rejected, and an unchanged collection is still revalidated without
-- rewriting its rows.
--
-- Every other write in this feature already filters: the staging cleanup by
-- batch and age, and the two state updates by the singleton `id` column.

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
    delete from public.instore_catalogue where sku is not null;
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

revoke all on function public.instore_catalogue_commit(uuid, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.instore_catalogue_commit(uuid, jsonb, text, text, integer) to service_role;
