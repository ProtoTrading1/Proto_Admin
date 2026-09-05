-- 027_units_of_issue.sql  (Stock Supabase project: yiqsvwajozafvalwcero)
-- Mirror of protoportal-main/migrations/027_units_of_issue.sql

alter table public.website_stock add column if not exists units_of_issue text;
alter table public.archived_products add column if not exists units_of_issue text;

create or replace function public.archive_product(p_sku text, p_by text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue,
    archived_at, archived_by
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue,
    now(), p_by
  from public.website_stock
  where sku = p_sku;

  delete from public.website_stock where sku = p_sku;
end;
$$;

create or replace function public.unarchive_product(p_sku text)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos,
    units_of_issue
  )
  select
    id, sku, barcode, title, original_description,
    image_url_one, image_url_two, image_url_three, image_url_four,
    category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
    created_at, now(), price, stock_qty, available_stock, coalesce(keep_live_when_oos, false),
    units_of_issue
  from public.archived_products
  where sku = p_sku;

  delete from public.archived_products where sku = p_sku;
end;
$$;

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
   where ws.barcode = NEW.sku
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
  v_website_stock_rows      integer;
  v_website_stock_updated   integer;
  v_unmatched               integer;
  v_barcode                 text;
begin
  with upd as (
    update public.website_stock ws
       set price           = p.sell_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           units_of_issue  = p.units_of_issue,
           updated_at      = now()
      from public.products p
     where p.sku = ws.barcode
       and (ws.price           is distinct from p.sell_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock
         or ws.units_of_issue  is distinct from p.units_of_issue)
    returning ws.barcode
  )
  select count(*) into v_website_stock_updated from upd;

  for v_barcode in
    select distinct p.sku
      from public.products p
     where exists (select 1 from public.website_stock ws where ws.barcode = p.sku)
        or exists (
          select 1 from public.archived_products ap
           where ap.barcode = p.sku and ap.archived_by = 'auto-oos'
        )
  loop
    perform public.apply_catalog_visibility_for_barcode(v_barcode);
  end loop;

  select count(distinct p.sku) into v_products_matched
    from public.website_stock ws
    join public.products p on p.sku = ws.barcode;

  select count(*) into v_website_stock_rows
    from public.website_stock ws
    join public.products p on p.sku = ws.barcode;

  select count(*) into v_unmatched
    from public.website_stock ws
   where not exists (select 1 from public.products p where p.sku = ws.barcode);

  return json_build_object(
    'products_matched',           v_products_matched,
    'website_products_updated',   0,
    'website_stock_rows_matched', v_website_stock_rows,
    'website_stock_updated',      v_website_stock_updated,
    'unmatched_skus_count',       v_unmatched,
    'synced_at',                  now()
  );
end;
$$;

select public.sync_website_from_products();
