-- Applied to production (Proto Trading Website) alongside 056.
--
-- 056 refused to trash any order carrying notification or delivery records.
-- Those are precisely the paid and confirmed orders an admin needs to remove,
-- so the guard made the feature useless for its actual purpose.
--
-- Dropping the guard alone would not work: order_notification_jobs/events are
-- ON DELETE CASCADE (silently destroyed) and order_delivery_jobs is ON DELETE
-- RESTRICT (the delete would raise a foreign-key violation). Capture the
-- linked rows in the trash record first, then remove them deliberately.

alter table public.admin_order_trash
  add column if not exists linked_snapshot jsonb not null default '{}'::jsonb;

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
  v_linked jsonb;
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

  select jsonb_build_object(
    'notification_jobs',   coalesce((select jsonb_agg(to_jsonb(j)) from public.order_notification_jobs   j where j.order_id::text = p_order_id), '[]'::jsonb),
    'notification_events', coalesce((select jsonb_agg(to_jsonb(e)) from public.order_notification_events e where e.order_id::text = p_order_id), '[]'::jsonb),
    'delivery_jobs',       coalesce((select jsonb_agg(to_jsonb(d)) from public.order_delivery_jobs       d where d.order_id::text = p_order_id), '[]'::jsonb)
  ) into v_linked;

  insert into public.admin_order_trash (order_id, order_snapshot, linked_snapshot, deleted_by, deletion_reason)
  values (p_order_id, v_snapshot, v_linked, coalesce(nullif(trim(p_actor), ''), 'unknown-admin'), trim(p_reason))
  returning id into v_trash_id;

  delete from public.order_delivery_jobs where order_id::text = p_order_id;
  delete from public.orders where id::text = p_order_id;
  return v_trash_id;
end;
$$;

revoke all on function public.trash_admin_order(text, text, text) from public, anon, authenticated;
grant execute on function public.trash_admin_order(text, text, text) to service_role;
