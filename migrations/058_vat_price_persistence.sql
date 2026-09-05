-- Keep customer-facing catalogue prices VAT-inclusive without multiplying a
-- correctly captured website price twice. The repair is deliberately limited
-- to the verified fingerprint: an off-grid price whose 15% VAT result lands
-- within one cent of Proto's .00/.50 website price grid.

lock table public.website_stock in share row exclusive mode;

create table if not exists public.website_price_vat_repair_20260801 (
  sku text primary key,
  old_price numeric not null,
  new_price numeric not null,
  captured_at timestamptz not null default now()
);

alter table public.website_price_vat_repair_20260801 enable row level security;
revoke all on table public.website_price_vat_repair_20260801 from public, anon, authenticated;
grant select on table public.website_price_vat_repair_20260801 to service_role;

do $$
declare
  v_matches integer;
begin
  select count(*)
    into v_matches
    from public.website_stock ws
   where coalesce(ws.price, 0) > 0
     and mod(round(ws.price * 100)::bigint, 50) <> 0
     and abs(
       (ws.price * 1.15)
       - (round((ws.price * 1.15) * 2) / 2.0)
     ) <= 0.01;

  if v_matches <> 36 then
    raise exception 'VAT repair expected exactly 36 rows, found %', v_matches;
  end if;
end;
$$;

insert into public.website_price_vat_repair_20260801 (sku, old_price, new_price)
select
  ws.sku,
  ws.price,
  round((ws.price * 1.15) * 2) / 2.0
from public.website_stock ws
where coalesce(ws.price, 0) > 0
  and mod(round(ws.price * 100)::bigint, 50) <> 0
  and abs(
    (ws.price * 1.15)
    - (round((ws.price * 1.15) * 2) / 2.0)
  ) <= 0.01;

do $$
declare
  v_updated integer;
begin
  update public.website_stock ws
     set price = repair.new_price,
         updated_at = now()
    from public.website_price_vat_repair_20260801 repair
   where repair.sku = ws.sku
     and ws.price is not distinct from repair.old_price;

  get diagnostics v_updated = row_count;
  if v_updated <> 36 then
    raise exception 'VAT repair expected to update exactly 36 rows, updated %', v_updated;
  end if;
end;
$$;

create or replace function public.trg_sync_product_to_website_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_website_price numeric;
begin
  v_website_price := case
    when coalesce(NEW.sell_price, 0) > 0
      and mod(round(NEW.sell_price * 100)::bigint, 50) <> 0
      and abs(
        (NEW.sell_price * 1.15)
        - (round((NEW.sell_price * 1.15) * 2) / 2.0)
      ) <= 0.01
    then round((NEW.sell_price * 1.15) * 2) / 2.0
    else NEW.sell_price
  end;

  update public.website_stock ws
     set price           = v_website_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         updated_at      = now()
    from public.website_products wp
   where wp.website_sku = ws.sku
     and wp.product_sku = NEW.sku
     and (ws.price           is distinct from v_website_price
       or ws.stock_qty       is distinct from NEW.stock_qty
       or ws.available_stock is distinct from NEW.available_stock);

  update public.website_stock ws
     set price           = v_website_price,
         stock_qty       = NEW.stock_qty,
         available_stock = NEW.available_stock,
         updated_at      = now()
   where ws.barcode = NEW.sku
     and not exists (
       select 1 from public.website_products wp
        where wp.website_sku = ws.sku and wp.product_sku = NEW.sku
     )
     and (ws.price           is distinct from v_website_price
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

  with corrected_products as (
    select
      p.*,
      case
        when coalesce(p.sell_price, 0) > 0
          and mod(round(p.sell_price * 100)::bigint, 50) <> 0
          and abs(
            (p.sell_price * 1.15)
            - (round((p.sell_price * 1.15) * 2) / 2.0)
          ) <= 0.01
        then round((p.sell_price * 1.15) * 2) / 2.0
        else p.sell_price
      end as website_price
    from public.products p
  ), upd as (
    update public.website_stock ws
       set price           = p.website_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           updated_at      = now()
      from public.website_products wp
      join corrected_products p on p.sku = wp.product_sku
     where wp.website_sku = ws.sku
       and (ws.price           is distinct from p.website_price
         or ws.stock_qty       is distinct from p.stock_qty
         or ws.available_stock is distinct from p.available_stock)
    returning ws.sku
  )
  select count(*) into v_website_stock_updated from upd;

  with corrected_products as (
    select
      p.*,
      case
        when coalesce(p.sell_price, 0) > 0
          and mod(round(p.sell_price * 100)::bigint, 50) <> 0
          and abs(
            (p.sell_price * 1.15)
            - (round((p.sell_price * 1.15) * 2) / 2.0)
          ) <= 0.01
        then round((p.sell_price * 1.15) * 2) / 2.0
        else p.sell_price
      end as website_price
    from public.products p
  ), upd2 as (
    update public.website_stock ws
       set price           = p.website_price,
           stock_qty       = p.stock_qty,
           available_stock = p.available_stock,
           updated_at      = now()
      from corrected_products p
     where ws.barcode = p.sku
       and not exists (
         select 1 from public.website_products wp
          where wp.website_sku = ws.sku and wp.product_sku = p.sku
       )
       and (ws.price           is distinct from p.website_price
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
