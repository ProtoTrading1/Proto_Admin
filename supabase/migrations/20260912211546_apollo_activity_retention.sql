-- Only Apollo raw activity; existing sales and legacy analytics remain untouched.
begin;
create function public.apollo_retain_activity()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare removed bigint; expired_months bigint;
begin
  -- Serialize this executor; the aggregation and deletion are one transaction.
  perform pg_catalog.pg_advisory_xact_lock(732145901);
  with expired as (
    delete from public.apollo_activity_events
    where occurred_at < now() - interval '90 days'
    returning occurred_at, source, event_type
  ), totals as (
    select date_trunc('month', occurred_at at time zone 'Africa/Johannesburg')::date as month,
      source, event_type, count(*) as event_count
    from expired group by 1,2,3
  ), saved as (
    insert into public.apollo_activity_monthly(month,source,event_type,event_count)
    select month,source,event_type,event_count from totals
    on conflict (month,source,event_type) do update
    set event_count = public.apollo_activity_monthly.event_count + excluded.event_count,
      updated_at = now()
    returning 1
  ) select count(*) into removed from expired;
  -- Keep the current calendar month and the preceding 23 months, SAST.
  delete from public.apollo_activity_monthly
  where month < (date_trunc('month', now() at time zone 'Africa/Johannesburg') - interval '23 months')::date;
  get diagnostics expired_months = row_count;
  return jsonb_build_object('raw_removed',removed,'monthly_removed',expired_months);
end;
$$;
revoke execute on function public.apollo_retain_activity() from public, anon, authenticated;
grant execute on function public.apollo_retain_activity() to service_role;
comment on function public.apollo_retain_activity() is
  '90-day Apollo activity retention; non-identifying monthly event counts only. No free-text, customer IDs, or active-duration totals retained. Scheduling is a separate release gate.';
commit;
