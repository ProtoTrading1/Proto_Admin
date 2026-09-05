-- 033_website_price_incl_vat.sql
-- website_stock.price is VAT-inclusive (15% SA), rounded up to the nearest whole rand.
-- products.sell_price remains ex-VAT (ERP source of truth).

create or replace function public.website_price_incl_vat(excl numeric)
returns numeric
language sql
immutable
as $$
  select case
    when excl is null or excl <= 0 then 0::numeric
    else ceil(excl * 1.15)::numeric
  end;
$$;

comment on function public.website_price_incl_vat(numeric) is
  'Convert ERP ex-VAT sell price to website incl-VAT price (15%, rounded up).';

-- Products trigger: sync SOH + VAT-inclusive pricing.
create or replace function public.trg_sync_product_to_website_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price numeric := public.website_price_incl_vat(NEW.sell_price);
begin
  update public.website_stock ws
     set price           = v_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         units_of_issue  = NEW.units_of_issue,
         updated_at      = now()
    from public.website_products wp
   where wp.website_sku = ws.sku
     and wp.product_sku = NEW.sku
     and (ws.price           is distinct from v_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock
       or ws.units_of_issue  is distinct from NEW.units_of_issue);

  update public.website_stock ws
     set price           = v_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         units_of_issue  = NEW.units_of_issue,
         updated_at      = now()
   where ws.barcode = NEW.sku
     and not exists (
       select 1 from public.website_products wp
        where wp.website_sku = ws.sku and wp.product_sku = NEW.sku
     )
     and (ws.price           is distinct from v_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock
       or ws.units_of_issue  is distinct from NEW.units_of_issue);

  return NEW;
end;
$$;

drop trigger if exists products_sync_to_website_stock on public.products;
create trigger products_sync_to_website_stock
  after insert or update of sell_price, stock_qty, available_stock, units_of_issue
  on public.products
  for each row
  execute function public.trg_sync_product_to_website_stock();

-- Bulk sync: VAT-inclusive pricing from products.sell_price.
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
       set price           = public.website_price_incl_vat(p.sell_price),
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           units_of_issue  = p.units_of_issue,
           updated_at      = now()
      from public.website_products wp
      join public.products p on p.sku = wp.product_sku
     where wp.website_sku = ws.sku
       and (ws.price           is distinct from public.website_price_incl_vat(p.sell_price)
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock
         or ws.units_of_issue  is distinct from p.units_of_issue)
    returning ws.sku
  )
  select count(*) into v_website_stock_updated from upd;

  with upd2 as (
    update public.website_stock ws
       set price           = public.website_price_incl_vat(p.sell_price),
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
       and (ws.price           is distinct from public.website_price_incl_vat(p.sell_price)
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock
         or ws.units_of_issue  is distinct from p.units_of_issue)
    returning ws.sku
  )
  select v_website_stock_updated + count(*) into v_website_stock_updated from upd2;

  select count(*) into v_website_products_count from public.website_products;

  select count(distinct wp.product_sku) into v_products_matched
    from public.website_products wp
   where wp.product_sku is not null;

  select count(*) into v_website_stock_rows
    from public.website_stock;

  select count(*) into v_unmatched
    from public.website_stock ws
   where not exists (
     select 1 from public.products p
      where p.sku = ws.barcode
         or exists (
           select 1 from public.website_products wp
            where wp.website_sku = ws.sku and wp.product_sku = p.sku
         )
   );

  return json_build_object(
    'website_products_count', v_website_products_count,
    'products_matched', v_products_matched,
    'website_stock_rows', v_website_stock_rows,
    'website_stock_updated', v_website_stock_updated,
    'unmatched', v_unmatched
  );
end;
$$;

-- One-time backfill: assume existing website_stock.price values are ex-VAT.
update public.website_stock
   set price = public.website_price_incl_vat(price),
       updated_at = now()
 where price is not null and price > 0;

update public.archived_products
   set price = public.website_price_incl_vat(price),
       updated_at = now()
 where price is not null and price > 0;

select public.sync_website_from_products();
