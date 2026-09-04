-- Record the first reliable approval transition for campaign conversion reporting.
-- Existing approved accounts are backfilled from created_at and explicitly
-- marked as inferred so the admin UI never presents historical estimates as
-- exact campaign attribution.

alter table public.customers
  add column if not exists approved_at timestamptz,
  add column if not exists approved_at_inferred boolean not null default false;

update public.customers
set approved_at = created_at,
    approved_at_inferred = true
where is_approved is true
  and approved_at is null;

create or replace function public.capture_customer_approved_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_approved is true then
    if tg_op = 'INSERT'
       and (new.approved_at is null or new.approved_at_inferred is true) then
      new.approved_at := now();
      new.approved_at_inferred := false;
    elsif tg_op = 'UPDATE'
       and old.is_approved is distinct from true
       and (new.approved_at is null or new.approved_at_inferred is true) then
      new.approved_at := now();
      new.approved_at_inferred := false;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists customers_capture_approved_at on public.customers;
create trigger customers_capture_approved_at
before insert or update on public.customers
for each row execute function public.capture_customer_approved_at();

create index if not exists customers_approved_at_idx
  on public.customers (approved_at desc)
  where is_approved is true;

comment on column public.customers.approved_at is
  'First reliable approval transition time; historical approved rows are backfilled from created_at.';
comment on column public.customers.approved_at_inferred is
  'True when approved_at was inferred from historical account creation rather than captured at approval time.';
