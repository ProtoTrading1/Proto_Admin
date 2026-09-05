-- Keep website_stock.units_of_issue as the customer-facing selling-unit source
-- of truth. Product Loader copies the ERP value on first publication, after
-- which an admin may deliberately change EACH to PACK 10, PAIR, SET, etc.
-- Price and stock continue to synchronise from public.products unchanged.

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
         updated_at      = now()
    from public.website_products wp
   where wp.website_sku = ws.sku
     and wp.product_sku = NEW.sku
     and (ws.price           is distinct from NEW.sell_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock);

  update public.website_stock ws
     set price           = NEW.sell_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         updated_at      = now()
   where ws.barcode = NEW.sku
     and not exists (
       select 1 from public.website_products wp
        where wp.website_sku = ws.sku and wp.product_sku = NEW.sku
     )
     and (ws.price           is distinct from NEW.sell_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock);

  return NEW;
end;
$$;

drop trigger if exists products_sync_to_website_stock on public.products;
create trigger products_sync_to_website_stock
  after insert or update of sell_price, stock_qty, available_stock
  on public.products
  for each row
  execute function public.trg_sync_product_to_website_stock();

revoke execute on function public.trg_sync_product_to_website_stock() from public;

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
       set price           = p.sell_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           updated_at      = now()
      from public.website_products wp
      join public.products p on p.sku = wp.product_sku
     where wp.website_sku = ws.sku
       and (ws.price           is distinct from p.sell_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock)
    returning ws.sku
  )
  select count(*) into v_website_stock_updated from upd;

  with upd2 as (
    update public.website_stock ws
       set price           = p.sell_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           updated_at      = now()
      from public.products p
     where ws.barcode = p.sku
       and not exists (
         select 1 from public.website_products wp
          where wp.website_sku = ws.sku and wp.product_sku = p.sku
       )
       and (ws.price           is distinct from p.sell_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock)
    returning ws.sku
  )
  select v_website_stock_updated + count(*) into v_website_stock_updated from upd2;

  select count(*) into v_products_matched from public.products;
  select count(*) into v_website_products_count from public.website_products;
  select count(*) into v_website_stock_rows from public.website_stock;
  select count(*) into v_unmatched
    from public.website_stock ws
   where not exists (
     select 1 from public.products p
      join public.website_products wp on wp.product_sku = p.sku and wp.website_sku = ws.sku
   )
   and not exists (select 1 from public.products p where p.sku = ws.barcode);

  return json_build_object(
    'products_matched', v_products_matched,
    'website_products_count', v_website_products_count,
    'website_stock_rows', v_website_stock_rows,
    'website_stock_updated', v_website_stock_updated,
    'unmatched', v_unmatched
  );
end;
$$;

revoke execute on function public.sync_website_from_products() from anon, authenticated;
revoke execute on function public.sync_website_from_products() from public;
grant execute on function public.sync_website_from_products() to service_role;
