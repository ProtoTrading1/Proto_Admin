-- 031_website_products_link.sql  (Stock Supabase project: yiqsvwajozafvalwcero)
-- Populate and maintain public.website_products as the explicit bridge between
-- website catalogue rows (website_stock) and ERP master (products via barcode).

-- product_sku mirrors barcode for joins to products.sku (explicit FK name in code).
alter table public.website_products
  add column if not exists product_sku text;

update public.website_products
   set product_sku = nullif(trim(barcode), '')
 where product_sku is null
   and nullif(trim(barcode), '') is not null;

create index if not exists website_products_product_sku_idx
  on public.website_products (product_sku);

create index if not exists website_products_barcode_idx
  on public.website_products (barcode);

comment on column public.website_products.product_sku is
  'ERP/stock master SKU (products.sku). Defaults to barcode.';

-- Upsert website_products row from a live website_stock row.
create or replace function public.upsert_website_product_from_stock(p_website_sku text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.website_stock%rowtype;
begin
  select * into r from public.website_stock where sku = p_website_sku;
  if not found then
    return;
  end if;

  insert into public.website_products (
    website_sku,
    barcode,
    product_sku,
    title,
    description,
    category,
    subcategory,
    leaf_category,
    image_url,
    active
  )
  values (
    r.sku,
    r.barcode,
    nullif(trim(r.barcode), ''),
    r.title,
    r.original_description,
    r.category,
    r.subcategory_one,
    coalesce(r.subcategory_four, r.subcategory_three, r.subcategory_two, r.subcategory_one, ''),
    nullif(trim(split_part(coalesce(r.image_url_one, ''), ',', 1)), ''),
    true
  )
  on conflict (website_sku) do update
     set barcode      = excluded.barcode,
         product_sku  = excluded.product_sku,
         title        = excluded.title,
         description  = excluded.description,
         category     = excluded.category,
         subcategory  = excluded.subcategory,
         leaf_category = excluded.leaf_category,
         image_url    = coalesce(excluded.image_url, public.website_products.image_url);
end;
$$;

create or replace function public.trg_upsert_website_product_from_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.upsert_website_product_from_stock(NEW.sku);
  return NEW;
end;
$$;

drop trigger if exists website_stock_upsert_website_product on public.website_stock;
create trigger website_stock_upsert_website_product
  after insert or update of sku, barcode, title, original_description, category,
    subcategory_one, subcategory_two, subcategory_three, subcategory_four, image_url_one
  on public.website_stock
  for each row
  execute function public.trg_upsert_website_product_from_stock();

-- Backfill all live catalogue rows.
insert into public.website_products (
  website_sku,
  barcode,
  product_sku,
  title,
  description,
  category,
  subcategory,
  leaf_category,
  image_url,
  active
)
select
  ws.sku,
  ws.barcode,
  nullif(trim(ws.barcode), ''),
  ws.title,
  ws.original_description,
  ws.category,
  ws.subcategory_one,
  coalesce(ws.subcategory_four, ws.subcategory_three, ws.subcategory_two, ws.subcategory_one, ''),
  nullif(trim(split_part(coalesce(ws.image_url_one, ''), ',', 1)), ''),
  true
from public.website_stock ws
where not exists (
  select 1 from public.website_products wp where wp.website_sku = ws.sku
);

-- Sync products SOH/pricing via website_products.product_sku (fallback: barcode).
create or replace function public.trg_sync_product_to_website_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.website_stock ws
     set price           = NEW.sell_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         units_of_issue  = NEW.units_of_issue,
         updated_at      = now()
    from public.website_products wp
   where wp.website_sku = ws.sku
     and wp.product_sku = NEW.sku
     and (ws.price           is distinct from NEW.sell_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock
       or ws.units_of_issue  is distinct from NEW.units_of_issue);

  update public.website_stock ws
     set price           = NEW.sell_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         units_of_issue  = NEW.units_of_issue,
         updated_at      = now()
   where ws.barcode = NEW.sku
     and not exists (
       select 1 from public.website_products wp
        where wp.website_sku = ws.sku and wp.product_sku = NEW.sku
     )
     and (ws.price           is distinct from NEW.sell_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock
       or ws.units_of_issue  is distinct from NEW.units_of_issue);

  perform public.apply_catalog_visibility_for_barcode(NEW.sku);
  return NEW;
end;
$$;

drop trigger if exists products_sync_to_website_stock on public.products;
create trigger products_sync_to_website_stock
  after insert or update of sell_price, stock_qty, available_stock, units_of_issue
  on public.products
  for each row
  execute function public.trg_sync_product_to_website_stock();

create or replace function public.sync_website_from_products()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_products_matched        integer;
  v_website_products_count  integer;
  v_website_stock_rows      integer;
  v_website_stock_updated   integer;
  v_unmatched               integer;
  v_barcode                 text;
begin
  insert into public.website_products (
    website_sku, barcode, product_sku, title, description, category, subcategory, leaf_category, image_url, active
  )
  select
    ws.sku, ws.barcode, nullif(trim(ws.barcode), ''), ws.title, ws.original_description,
    ws.category, ws.subcategory_one,
    coalesce(ws.subcategory_four, ws.subcategory_three, ws.subcategory_two, ws.subcategory_one, ''),
    nullif(trim(split_part(coalesce(ws.image_url_one, ''), ',', 1)), ''),
    true
  from public.website_stock ws
  where not exists (select 1 from public.website_products wp where wp.website_sku = ws.sku);

  with upd as (
    update public.website_stock ws
       set price           = p.sell_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           units_of_issue  = p.units_of_issue,
           updated_at      = now()
      from public.website_products wp
      join public.products p on p.sku = wp.product_sku
     where wp.website_sku = ws.sku
       and (ws.price           is distinct from p.sell_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock
         or ws.units_of_issue  is distinct from p.units_of_issue)
    returning ws.sku
  )
  select count(*) into v_website_stock_updated from upd;

  with upd2 as (
    update public.website_stock ws
       set price           = p.sell_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           units_of_issue  = p.units_of_issue,
           updated_at      = now()
      from public.products p
     where p.sku = ws.barcode
       and not exists (
         select 1 from public.website_products wp
          where wp.website_sku = ws.sku and wp.product_sku = p.sku
       )
       and (ws.price           is distinct from p.sell_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock
         or ws.units_of_issue  is distinct from p.units_of_issue)
    returning ws.sku
  )
  select v_website_stock_updated + count(*) into v_website_stock_updated from upd2;

  for v_barcode in
    select distinct coalesce(wp.product_sku, ws.barcode)
      from public.website_stock ws
      left join public.website_products wp on wp.website_sku = ws.sku
     where coalesce(wp.product_sku, ws.barcode) is not null
  loop
    perform public.apply_catalog_visibility_for_barcode(v_barcode);
  end loop;

  select count(*) into v_website_products_count from public.website_products;

  select count(distinct wp.product_sku) into v_products_matched
    from public.website_products wp
   where wp.product_sku is not null;

  select count(*) into v_website_stock_rows
    from public.website_products wp
    join public.products p on p.sku = wp.product_sku;

  select count(*) into v_unmatched
    from public.website_stock ws
   where not exists (
     select 1 from public.website_products wp
      where wp.website_sku = ws.sku and wp.product_sku is not null
   )
     and not exists (
       select 1 from public.products p where p.sku = ws.barcode
     );

  return json_build_object(
    'products_matched',           v_products_matched,
    'website_products_count',     v_website_products_count,
    'website_stock_rows_matched', v_website_stock_rows,
    'website_stock_updated',      v_website_stock_updated,
    'unmatched_skus_count',       v_unmatched,
    'synced_at',                  now()
  );
end;
$$;

select public.sync_website_from_products();
