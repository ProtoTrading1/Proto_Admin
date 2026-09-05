-- 053: "Archive doesn't stick" fix — a live SKU may not also carry a true-archive row.
--
-- Root cause: archive_product / unarchive_product are correct and atomic, but
-- app write paths that INSERT into website_stock directly (product create,
-- product-loader publish, re-link) do NOT remove any pre-existing
-- archived_products row for that SKU. So re-creating or re-publishing a SKU that
-- had been recycled / bulk-archived left the old archive row behind, and the
-- product showed as BOTH live and archived.
--
-- Fix: enforce the invariant at the DB level so it holds no matter which code
-- path inserts the live row. When a row lands in website_stock, drop any
-- "true" archive row for that SKU. Loader staging placeholders (new-products,
-- nutstore) are intentionally allowed to coexist with a live product and are
-- left untouched.

create or replace function public.detach_archive_on_live_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  delete from public.archived_products
   where sku = NEW.sku
     and coalesce(archived_by, '') not in ('new-products', 'nutstore');
  return NEW;
end;
$$;

drop trigger if exists trg_detach_archive_on_live_insert on public.website_stock;
create trigger trg_detach_archive_on_live_insert
  after insert on public.website_stock
  for each row execute function public.detach_archive_on_live_insert();

-- One-time cleanup of existing inconsistencies: any product currently live keeps
-- its live row (nothing is hidden from customers); the contradictory true-archive
-- row is removed. Staging placeholders are excluded. Re-archiving via the UI now
-- sticks, since archive_product removes the live row and this trigger prevents a
-- later live insert from resurrecting the archive.
delete from public.archived_products ap
 where coalesce(ap.archived_by, '') not in ('new-products', 'nutstore')
   and exists (select 1 from public.website_stock ws where ws.sku = ap.sku);
