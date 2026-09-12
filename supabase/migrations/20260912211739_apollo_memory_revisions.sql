begin;
create table public.apollo_memory_revisions (
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  version integer not null check (version > 0),
  kind text not null check (kind in ('definition','decision')),
  title text not null check (length(trim(title)) between 1 and 240),
  body text not null check (length(trim(body)) between 1 and 10000),
  evidence_refs text[] not null check (cardinality(evidence_refs) between 1 and 20 and array_position(evidence_refs,null) is null),
  state text not null check (state in ('draft','approved','superseded','rejected')),
  reviewer uuid not null,
  recorded_at timestamptz not null default now(),
  primary key (key,version)
);
alter table public.apollo_memory_revisions enable row level security;
revoke all on public.apollo_memory_revisions from public,anon,authenticated;
grant select,insert on public.apollo_memory_revisions to service_role;

create function public.apollo_memory_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Apollo memory history is append-only; record a new revision';
end;
$$;
revoke execute on function public.apollo_memory_immutable() from public,anon,authenticated;
create trigger apollo_memory_immutable before update or delete on public.apollo_memory_revisions
  for each row execute function public.apollo_memory_immutable();

-- Only an owner-authorized server can call this. The server obtains reviewer
-- from verified authentication, not a field in the request body.
create function public.apollo_append_memory(p_key text,p_expected_version integer,p_kind text,
  p_title text,p_body text,p_evidence_refs text[],p_state text,p_reviewer uuid)
returns public.apollo_memory_revisions language plpgsql security invoker set search_path = '' as $$
declare current_version integer; previous_kind text; saved public.apollo_memory_revisions;
begin
  if p_key is null or p_key !~ '^[a-z0-9][a-z0-9._-]{0,119}$' or
     p_expected_version is null or p_expected_version < 0 or p_reviewer is null then
    raise exception 'Invalid memory identity or expected version' using errcode='22023';
  end if;
  if p_evidence_refs is null or cardinality(p_evidence_refs) not between 1 and 20
    or exists(select 1 from unnest(p_evidence_refs) e where e is null or length(trim(e)) not between 1 and 500) then
    raise exception 'Evidence references required' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('apollo.memory.' || p_key,0));
  select version,kind into current_version,previous_kind from public.apollo_memory_revisions
    where key=p_key order by version desc limit 1;
  if coalesce(current_version,0) <> p_expected_version then
    raise exception 'Memory version changed; reload before reviewing' using errcode='40001';
  end if;
  if previous_kind is not null and previous_kind <> p_kind then
    raise exception 'Memory kind cannot change across revisions' using errcode='22023';
  end if;
  insert into public.apollo_memory_revisions(key,version,kind,title,body,evidence_refs,state,reviewer)
    values(p_key,p_expected_version+1,p_kind,trim(p_title),trim(p_body),p_evidence_refs,p_state,p_reviewer)
    returning * into saved;
  return saved;
end;
$$;
revoke execute on function public.apollo_append_memory(text,integer,text,text,text,text[],text,uuid) from public,anon,authenticated;
grant execute on function public.apollo_append_memory(text,integer,text,text,text,text[],text,uuid) to service_role;
comment on table public.apollo_memory_revisions is
 'Reviewed business definitions and decisions only; never a substitute for live sales reports. Latest revision governs current retrieval; all history retained.';
commit;
