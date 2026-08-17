-- Backend-sent marketing emails are transactional Brevo sends, not Brevo
-- campaigns, so the admin backend owns unsubscribe state.

create table if not exists public.marketing_email_opt_outs (
  email text primary key,
  source text not null default 'email_unsubscribe_link',
  unsubscribed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint marketing_email_opt_outs_email_not_blank check (length(btrim(email)) > 0)
);

create unique index if not exists marketing_email_opt_outs_email_lower_idx
  on public.marketing_email_opt_outs (lower(btrim(email)));

alter table public.marketing_email_opt_outs enable row level security;
revoke all on table public.marketing_email_opt_outs from anon, authenticated;
grant all on table public.marketing_email_opt_outs to service_role;

comment on table public.marketing_email_opt_outs is
  'Global suppression list for admin backend marketing broadcasts. Service emails are not filtered by this table.';
