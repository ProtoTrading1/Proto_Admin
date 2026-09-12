begin;

-- Return complete histories for a bounded page of stable keys. Returning every
-- revision for selected keys is deliberate: current retrieval must see a newer
-- draft, rejection, or supersession before it can expose an older approval.
create function public.apollo_read_memory(p_after_key text default null, p_limit integer default 50)
returns setof public.apollo_memory_revisions
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Memory page size must be between 1 and 100' using errcode = '22023';
  end if;
  if p_after_key is not null and p_after_key !~ '^[a-z0-9][a-z0-9._-]{0,119}$' then
    raise exception 'Invalid memory cursor' using errcode = '22023';
  end if;

  return query
    with selected_keys as (
      select r.key
      from public.apollo_memory_revisions r
      where p_after_key is null or r.key > p_after_key
      group by r.key
      order by r.key
      limit p_limit
    )
    select r.*
    from public.apollo_memory_revisions r
    join selected_keys k using (key)
    order by r.key asc, r.version asc;
end;
$$;

revoke execute on function public.apollo_read_memory(text,integer) from public,anon,authenticated;
grant execute on function public.apollo_read_memory(text,integer) to service_role;
comment on function public.apollo_read_memory(text,integer) is
  'Bounded stable-key pagination for Apollo memory. Returns complete revision histories so approved-only reads fail closed.';

commit;
