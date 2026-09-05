-- CRM contacts cache (main/portal Supabase project)
-- Background-synced from Brevo via api/brevo-sync.js — never call Brevo live from the CRM tab.

create table if not exists public.crm_contacts (
  id                   uuid primary key default gen_random_uuid(),
  brevo_id             bigint unique,
  email                text not null,
  name                 text,
  list_ids             jsonb default '[]'::jsonb,
  list_names           jsonb default '[]'::jsonb,
  last_campaign_name   text,
  last_sent_at         timestamptz,
  last_open_at         timestamptz,
  last_click_at        timestamptz,
  synced_at            timestamptz default now()
);

create index if not exists crm_contacts_email_idx on public.crm_contacts (email);
create index if not exists crm_contacts_synced_at_idx on public.crm_contacts (synced_at desc);

alter table public.crm_contacts enable row level security;
-- No public policies — service role only via admin API.
