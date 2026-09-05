-- 050: Stop archive/unarchive silently dropping seven columns.
--
-- archive_product and unarchive_product copy a HARDCODED column list that has
-- not kept pace with the schema. Seven columns exist in BOTH website_stock and
-- archived_products but are copied by neither function, so they are destroyed
-- on archive and cannot be restored on unarchive:
--
--   subcategory_extra  -- category depth beyond subcategory_four (migration 043)
--   mottaro_path       -- persisted Mottaro placement          (migration 038)
--   pack_description   --                                       (migration 026)
--   to_order           --                                       (migration 044)
--   moved_at / moved_from / moved_to  -- primary-move audit tag
--
-- Practical effect: archiving a deeply-filed product FLATTENS it to four
-- levels, and unarchiving returns it to the wrong place in the tree. It also
-- loses its Mottaro position, its "to order" flag and its pack description.
--
-- Both functions are rewritten with the full shared column list. Types match
-- across the two tables for all seven. Only to_order is NOT NULL (default
-- false), so it is coalesced on the way in, matching how keep_live_when_oos
-- and is_new_arrival were already handled.
--
-- This is a data-integrity fix, not a feature. It does not repair rows already
-- archived with the columns missing — that data is gone. It only stops further
-- loss.
--
-- Drift check — this must return zero rows after applying. Re-run it whenever
-- a column is added to website_stock:
--
--   with copied as (select unnest(array[
--     'id','sku','barcode','title','original_description',
--     'image_url_one','image_url_two','image_url_three','image_url_four',
--     'category','subcategory_one','subcategory_two','subcategory_three','subcategory_four',
--     'subcategory_extra','mottaro_path','pack_description','to_order',
--     'moved_at','moved_from','moved_to',
--     'created_at','updated_at','price','stock_qty','available_stock',
--     'keep_live_when_oos','units_of_issue','is_new_arrival']) as column_name)
--   select w.column_name from information_schema.columns w
--   join information_schema.columns a
--     on a.table_schema='public' and a.table_name='archived_products'
--    and a.column_name = w.column_name
--   left join copied c on c.column_name = w.column_name
--   where w.table_schema='public' and w.table_name='website_stock'
--     and c.column_name is null;
--
-- Deploy order: standalone. No application code change required.
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/050_archive_rpc_column_drift.sql

CREATE OR REPLACE FUNCTION public.archive_product(p_sku text, p_by text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from public.website_stock where sku = p_sku) then
    raise exception 'archive_product: SKU % not found in website_stock', p_sku
      using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.archived_products where sku = p_sku) then
    raise exception 'archive_product: SKU % already archived', p_sku
      using errcode = 'unique_violation';
  end if;

  insert into public.archived_products (
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, to_order,
    moved_at, moved_from, moved_to,
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue, is_new_arrival,
    archived_at, archived_by
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, coalesce(to_order, false),
    moved_at, moved_from, moved_to,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue, coalesce(is_new_arrival, false),
    now(), p_by
  from public.website_stock
  where sku = p_sku;

  delete from public.website_stock where sku = p_sku;
end;
$function$;

CREATE OR REPLACE FUNCTION public.unarchive_product(p_sku text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from public.archived_products where sku = p_sku) then
    raise exception 'unarchive_product: SKU % not found in archived_products', p_sku
      using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.website_stock where sku = p_sku) then
    raise exception 'unarchive_product: SKU % already live', p_sku
      using errcode = 'unique_violation';
  end if;

  insert into public.website_stock (
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, to_order,
    moved_at, moved_from, moved_to,
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue, is_new_arrival
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, coalesce(to_order, false),
    moved_at, moved_from, moved_to,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue, coalesce(is_new_arrival, false)
  from public.archived_products
  where sku = p_sku;

  delete from public.archived_products where sku = p_sku;
end;
$function$;
