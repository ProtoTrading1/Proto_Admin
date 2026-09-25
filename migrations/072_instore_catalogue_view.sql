-- 072_instore_catalogue_view (Stock Supabase project: yiqsvwajozafvalwcero)
--
-- Serving a landing or category page of Instore Products took two sequential
-- round trips from the portal's serverless function: the snapshot state plus
-- the two Instore control tables, then the page of products. This returns all
-- of it in one call, so a customer with nothing cached waits for one database
-- round trip instead of two.
--
-- It is read-only and decides nothing. In particular it does not decide whether
-- the snapshot may be served: it returns the current hidden-control SKUs next
-- to the fingerprint the snapshot was built under, and the caller still
-- compares them itself, exactly as it does when it reads the control tables
-- directly. A snapshot built under superseded controls is still refused, so
-- hiding an Instore image or listing still takes effect immediately.
--
-- Being read-only, this is not exposed to the `safeupdate` guard that migration
-- 071 had to fix in `instore_catalogue_commit`.

create or replace function public.instore_catalogue_view(
  p_category text default '',
  p_from integer default 0,
  p_limit integer default 60
)
returns jsonb
language sql
security invoker
stable
set search_path = public
as $$
  select jsonb_build_object(
    'refreshed_at', s.refreshed_at,
    'product_count', s.product_count,
    'controls_fingerprint', s.controls_fingerprint,
    'tiles', s.tiles,
    'hidden_image_skus', coalesce((
      select jsonb_agg(sku order by sku)
      from public.instore_image_controls where status = 'hidden'
    ), '[]'::jsonb),
    'hidden_listing_skus', coalesce((
      select jsonb_agg(sku order by sku)
      from public.instore_listing_controls where status = 'hidden'
    ), '[]'::jsonb),
    'total', (
      select count(*) from public.instore_catalogue c
      where coalesce(nullif(p_category, ''), c.discovery_group) = c.discovery_group
    ),
    'products', coalesce((
      select jsonb_agg(page.payload order by page.sort_index)
      from (
        select c.payload, c.sort_index
        from public.instore_catalogue c
        where coalesce(nullif(p_category, ''), c.discovery_group) = c.discovery_group
        order by c.sort_index
        offset greatest(coalesce(p_from, 0), 0)
        limit least(greatest(coalesce(p_limit, 60), 1), 200)
      ) page
    ), '[]'::jsonb)
  )
  from public.instore_catalogue_state s
  where s.id;
$$;

revoke all on function public.instore_catalogue_view(text, integer, integer) from public, anon, authenticated;
grant execute on function public.instore_catalogue_view(text, integer, integer) to service_role;
