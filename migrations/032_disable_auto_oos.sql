-- 032_disable_auto_oos.sql  (Stock Supabase project: yiqsvwajozafvalwcero)
-- Disable automatic out-of-stock archiving. Catalogue visibility is manual only
-- (Archive / Make live in Product Manager). SOH still syncs from products → website_stock.

create or replace function public.apply_catalog_visibility_for_barcode(p_barcode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock numeric;
  v_sku text;
begin
  if p_barcode is null or trim(p_barcode) = '' then
    return;
  end if;

  select coalesce(p.available_stock, p.stock_qty, 0)
    into v_stock
    from public.products p
   where p.sku = p_barcode;

  -- Legacy path: auto-unarchive rows that were auto-archived before this migration.
  if coalesce(v_stock, 0) > 0 then
    select ap.sku into v_sku
      from public.archived_products ap
     where ap.barcode = p_barcode
       and ap.archived_by = 'auto-oos'
     limit 1;

    if v_sku is not null then
      perform public.unarchive_product(v_sku);
    end if;
  end if;

  -- Never auto-archive on zero stock.
end;
$$;

comment on function public.apply_catalog_visibility_for_barcode(text) is
  'Legacy auto-unarchive for auto-oos rows when stock returns. No auto-archive.';

-- Products trigger: sync SOH/pricing only — no visibility side effects.
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

  return NEW;
end;
$$;

drop trigger if exists products_sync_to_website_stock on public.products;
create trigger products_sync_to_website_stock
  after insert or update of sell_price, stock_qty, available_stock, units_of_issue
  on public.products
  for each row
  execute function public.trg_sync_product_to_website_stock();

-- Bulk sync: update SOH/pricing only — skip visibility loop.
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
