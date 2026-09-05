-- Portal project: kyodrsqnmihwoplkhwwf
--
-- Email groups: labelled mailing lists uploaded by CSV (the "10000 club" and
-- friends), used as a broadcast audience.
--
-- These are deliberately NOT customers. Members live only in these two tables,
-- are never written to public.customers, and have no auth account — so they
-- can never appear in Customer Management, in a customer count, or in any
-- audience other than their own group. That separation is the whole point of
-- the feature and is enforced by construction rather than by a filter someone
-- has to remember.

create table if not exists public.email_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_groups_name_not_blank check (length(btrim(name)) > 0)
);

-- One group per label, case-insensitively — "10000 Club" and "10000 club"
-- are the same list, and a second upload should extend it, not shadow it.
create unique index if not exists email_groups_name_key
  on public.email_groups (lower(btrim(name)));

create table if not exists public.email_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.email_groups(id) on delete cascade,
  email text not null,
  name text not null default '',
  business_name text not null default '',
  created_at timestamptz not null default now(),
  constraint email_group_members_email_not_blank check (length(btrim(email)) > 0)
);

-- Re-uploading a list must not duplicate anyone already on it.
create unique index if not exists email_group_members_unique
  on public.email_group_members (group_id, lower(btrim(email)));

create index if not exists email_group_members_group_idx
  on public.email_group_members (group_id);

alter table public.email_groups enable row level security;
alter table public.email_group_members enable row level security;
revoke all on table public.email_groups from anon, authenticated;
revoke all on table public.email_group_members from anon, authenticated;
grant all on table public.email_groups to service_role;
grant all on table public.email_group_members to service_role;

comment on table public.email_groups is
  'Labelled mailing lists for admin broadcasts. Members are not customers and never appear in Customer Management.';
