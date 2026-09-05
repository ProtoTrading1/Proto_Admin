-- DRAFT / EXPLICIT RELEASE GATE
-- Do not apply without a separately approved database migration and rollback check.
-- Application code remains disabled unless ORDER_TRASH_ENABLED=true.

begin;

create table if not exists public.admin_order_trash (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  order_snapshot jsonb not null,
  deleted_at timestamptz not null default now(),
  deleted_by text not null,
  deletion_reason text not null check (char_length(deletion_reason) between 8 and 500),
  restored_at timestamptz,
  restored_by text
);

create unique index if not exists admin_order_trash_active_order_idx
  on public.admin_order_trash (order_id)
  where restored_at is null;

create index if not exists admin_order_trash_deleted_at_idx
  on public.admin_order_trash (deleted_at desc);

alter table public.admin_order_trash enable row level security;
revoke all on table public.admin_order_trash from anon, authenticated;
grant select, insert, update on table public.admin_order_trash to service_role;

create or replace function public.trash_admin_order(
  p_order_id text,
  p_actor text,
  p_reason text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_snapshot jsonb;
  v_trash_id uuid;
begin
  if char_length(trim(coalesce(p_reason, ''))) not between 8 and 500 then
    raise exception 'A deletion reason of 8 to 500 characters is required';
  end if;

  select to_jsonb(o) into v_snapshot
  from public.orders o
  where o.id::text = p_order_id
  for update;

  if v_snapshot is null then
    raise exception 'Order not found';
  end if;

  -- Do not cascade-delete notification history or detach an in-flight
  -- delivery job. Those records are operational evidence and restoring them
  -- could replay a queued notification. They must be reconciled separately
  -- before an order is eligible for recoverable trash.
  if exists (select 1 from public.order_notification_jobs where order_id::text = p_order_id)
    or exists (select 1 from public.order_notification_events where order_id::text = p_order_id)
    or exists (select 1 from public.order_delivery_jobs where order_id::text = p_order_id) then
    raise exception 'Order has linked delivery or notification records and cannot be moved to trash';
  end if;

  insert into public.admin_order_trash (order_id, order_snapshot, deleted_by, deletion_reason)
  values (p_order_id, v_snapshot, coalesce(nullif(trim(p_actor), ''), 'unknown-admin'), trim(p_reason))
  returning id into v_trash_id;

  delete from public.orders where id::text = p_order_id;
  return v_trash_id;
end;
$$;

create or replace function public.restore_admin_order(
  p_trash_id text,
  p_actor text
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order_id text;
  v_snapshot jsonb;
  v_order public.orders%rowtype;
begin
  select order_id, order_snapshot into v_order_id, v_snapshot
  from public.admin_order_trash
  where id::text = p_trash_id and restored_at is null
  for update;

  if v_snapshot is null then
    raise exception 'Recoverable order not found';
  end if;

  if exists (select 1 from public.orders where id::text = v_order_id) then
    raise exception 'An active order with this id already exists';
  end if;

  v_order := jsonb_populate_record(null::public.orders, v_snapshot);

  -- Keep this list explicit. `orders.items_search` is a stored generated
  -- column and PostgreSQL rejects attempts to restore a snapshot value into
  -- it. New nullable/defaulted columns can also be added later without making
  -- older trash snapshots unrestorable.
  insert into public.orders (
    id,
    customer_id,
    items,
    total_ex_vat,
    status,
    created_at,
    order_number,
    viewed_at,
    original_items,
    final_items,
    order_match,
    order_change_notes,
    replacement_map,
    paid_at,
    delivered_at,
    handed_over_at,
    order_in_progress_at,
    order_sent_at,
    payment_received_at,
    delivery_method,
    customer_notes,
    confirmation_sent_at,
    promo_code,
    discount_pct,
    discount_amount,
    client_ref
  ) values (
    v_order.id,
    v_order.customer_id,
    v_order.items,
    v_order.total_ex_vat,
    v_order.status,
    v_order.created_at,
    v_order.order_number,
    v_order.viewed_at,
    v_order.original_items,
    v_order.final_items,
    v_order.order_match,
    v_order.order_change_notes,
    v_order.replacement_map,
    v_order.paid_at,
    v_order.delivered_at,
    v_order.handed_over_at,
    v_order.order_in_progress_at,
    v_order.order_sent_at,
    v_order.payment_received_at,
    v_order.delivery_method,
    v_order.customer_notes,
    v_order.confirmation_sent_at,
    v_order.promo_code,
    v_order.discount_pct,
    v_order.discount_amount,
    v_order.client_ref
  );

  update public.admin_order_trash
  set restored_at = now(), restored_by = coalesce(nullif(trim(p_actor), ''), 'unknown-admin')
  where id::text = p_trash_id;

  return v_order_id;
end;
$$;

revoke all on function public.trash_admin_order(text, text, text) from public, anon, authenticated;
revoke all on function public.restore_admin_order(text, text) from public, anon, authenticated;
grant execute on function public.trash_admin_order(text, text, text) to service_role;
grant execute on function public.restore_admin_order(text, text) to service_role;

commit;
