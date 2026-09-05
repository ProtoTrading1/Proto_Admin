-- Per-product customer minimum, measured in selling units.
-- Example: units_of_issue = PACK 10 and min_order_qty = 3 means a minimum
-- customer order of three packs (30 individual pieces).

alter table public.website_stock
  add column if not exists min_order_qty integer not null default 1;

alter table public.archived_products
  add column if not exists min_order_qty integer not null default 1;

alter table public.website_stock
  drop constraint if exists website_stock_min_order_qty_check;

alter table public.website_stock
  add constraint website_stock_min_order_qty_check
  check (min_order_qty between 1 and 9999);

alter table public.archived_products
  drop constraint if exists archived_products_min_order_qty_check;

alter table public.archived_products
  add constraint archived_products_min_order_qty_check
  check (min_order_qty between 1 and 9999);

comment on column public.website_stock.min_order_qty is
  'Minimum customer order measured in units_of_issue; defaults to one selling unit.';

comment on column public.archived_products.min_order_qty is
  'Archived copy of the minimum customer order measured in selling units.';

create or replace function public.archive_product(p_sku text, p_by text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.website_stock where sku = p_sku) then
    raise exception 'archive_product: SKU % not found in website_stock', p_sku using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.archived_products where sku = p_sku) then
    raise exception 'archive_product: SKU % already archived', p_sku using errcode = 'unique_violation';
  end if;

  insert into public.archived_products (
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, to_order,
    moved_at, moved_from, moved_to,
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue, min_order_qty, is_new_arrival,
    archived_at, archived_by
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, coalesce(to_order, false),
    moved_at, moved_from, moved_to,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue, coalesce(min_order_qty, 1), coalesce(is_new_arrival, false),
    now(), p_by
  from public.website_stock
  where sku = p_sku;

  delete from public.website_stock where sku = p_sku;
end;
$function$;

create or replace function public.unarchive_product(p_sku text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.archived_products where sku = p_sku) then
    raise exception 'unarchive_product: SKU % not found in archived_products', p_sku using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.website_stock where sku = p_sku) then
    raise exception 'unarchive_product: SKU % already live', p_sku using errcode = 'unique_violation';
  end if;

  insert into public.website_stock (
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, to_order,
    moved_at, moved_from, moved_to,
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue, min_order_qty, is_new_arrival
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    subcategory_extra, mottaro_path, pack_description, coalesce(to_order, false),
    moved_at, moved_from, moved_to,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue, coalesce(min_order_qty, 1), coalesce(is_new_arrival, false)
  from public.archived_products
  where sku = p_sku;

  delete from public.archived_products where sku = p_sku;
end;
$function$;

revoke execute on function public.archive_product(text, text) from public;
revoke execute on function public.unarchive_product(text) from public;
