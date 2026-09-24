-- 070: WhatsApp CRM (WATI) — consented broadcasts, opt-outs, click analytics.
--
-- Consent rule, and the reason these tables exist:
--   The ONLY customers that may be pushed to WATI or receive a broadcast are
--   those with customers.accept_whatsapp = true, a format-valid number, and no
--   row in whatsapp_opt_outs. That gate lives in api/_whatsapp-audience.js and
--   is re-applied server-side on EVERY send, including "selected" sends, so a
--   stale browser list can never reach someone who opted out.
--
-- This migration is deliberately additive. whatsapp_contacts (96 rows),
-- whatsapp_messages, whatsapp_broadcasts and whatsapp_webhook_events survived
-- the feature removal in migration 055 (which only dropped whatsapp_sessions).
-- Their shape is a good fit, so we extend them instead of dropping and losing
-- the contact rows already there.

-- ---------------------------------------------------------------------------
-- whatsapp_contacts — mirror of the WATI contact list, so the admin can see
-- sync state without paging the WATI API on every screen load.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_contacts
  add column if not exists email text,
  add column if not exists contact_name text,
  add column if not exists business_name text,
  -- 'sa_mobile' | 'sa_landline' | 'international' — a landline will not accept
  -- WhatsApp, and saying so beats a silent delivery failure.
  add column if not exists phone_kind text,
  add column if not exists wati_contact_id text,
  -- 'pending' | 'synced' | 'failed' | 'not_whatsapp'
  add column if not exists sync_status text not null default 'pending',
  add column if not exists sync_error text,
  add column if not exists last_broadcast_at timestamptz;

create index if not exists whatsapp_contacts_sync_status_idx
  on public.whatsapp_contacts (sync_status);
create index if not exists whatsapp_contacts_email_idx
  on public.whatsapp_contacts (lower(btrim(email)));

-- ---------------------------------------------------------------------------
-- whatsapp_opt_outs — hard suppression list. A number in here can never be
-- broadcast to again, whatever the customer row says: an opt-out outranks a
-- stale accept_whatsapp = true.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_opt_outs (
  phone text primary key,
  customer_id uuid references public.customers(id) on delete set null,
  email text,
  -- 'customer_reply' | 'wati_contact_sync' | 'admin' | 'failed_delivery'
  source text not null default 'customer_reply',
  reason text,
  opted_out_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint whatsapp_opt_outs_phone_not_blank check (length(btrim(phone)) > 0)
);

create index if not exists whatsapp_opt_outs_opted_out_at_idx
  on public.whatsapp_opt_outs (opted_out_at desc);

-- ---------------------------------------------------------------------------
-- whatsapp_broadcasts — one row per broadcast the admin sends.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_broadcasts
  add column if not exists template_language text,
  -- Rendered preview of the template body with the admin's parameters filled
  -- in, so history stays readable after the template is edited in WATI.
  add column if not exists body_preview text,
  add column if not exists parameters jsonb not null default '{}'::jsonb,
  -- Destination of the per-recipient tracked link, when the broadcast used one.
  add column if not exists tracked_url text,
  -- Eligible-but-suppressed recipients (opted out, or invalid number).
  add column if not exists count_skipped integer not null default 0,
  add column if not exists count_clicked integer not null default 0,
  add column if not exists error text;

-- A broadcast that fails outright needs its own state; the original check
-- allowed only queued/sending/completed/cancelled.
alter table public.whatsapp_broadcasts
  drop constraint if exists whatsapp_broadcasts_status_check;
alter table public.whatsapp_broadcasts
  add constraint whatsapp_broadcasts_status_check
  check (status = any (array['queued', 'sending', 'completed', 'cancelled', 'failed']));

-- ---------------------------------------------------------------------------
-- whatsapp_messages — the per-recipient delivery row. WhatsApp reports
-- sent/delivered/read per message; it does NOT report link clicks, so
-- click_count is fed by our own tracked redirect (api/wa-click.js).
-- ---------------------------------------------------------------------------
alter table public.whatsapp_messages
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists email text,
  add column if not exists contact_name text,
  add column if not exists business_name text,
  -- Random per-recipient token embedded in the tracked link, so a click
  -- identifies exactly one recipient of exactly one broadcast.
  add column if not exists click_token text,
  add column if not exists click_count integer not null default 0,
  add column if not exists first_clicked_at timestamptz,
  add column if not exists last_clicked_at timestamptz,
  add column if not exists replied_at timestamptz;

create unique index if not exists whatsapp_messages_click_token_key
  on public.whatsapp_messages (click_token) where click_token is not null;
-- One outbound row per number per broadcast: makes the send idempotent and
-- stops a retried broadcast double-counting the funnel.
create unique index if not exists whatsapp_messages_broadcast_phone_key
  on public.whatsapp_messages (broadcast_id, phone)
  where broadcast_id is not null and direction = 'out';
create index if not exists whatsapp_messages_customer_idx
  on public.whatsapp_messages (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- whatsapp_webhook_events — raw event log, kept separate from the message row
-- so a replayed or out-of-order webhook can be audited without corrupting the
-- funnel counts.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_webhook_events
  add column if not exists wa_message_id text,
  add column if not exists broadcast_id uuid references public.whatsapp_broadcasts(id) on delete set null,
  add column if not exists link text,
  add column if not exists text_body text;

create index if not exists whatsapp_webhook_events_broadcast_idx
  on public.whatsapp_webhook_events (broadcast_id, received_at desc)
  where broadcast_id is not null;
create index if not exists whatsapp_webhook_events_phone_idx
  on public.whatsapp_webhook_events (phone, received_at desc);

-- ---------------------------------------------------------------------------
-- Service-role only. These tables hold phone numbers and consent state, and
-- every caller is an authenticated admin route or the signed WATI webhook.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_broadcasts enable row level security;
alter table public.whatsapp_webhook_events enable row level security;
alter table public.whatsapp_opt_outs enable row level security;

revoke all on table public.whatsapp_contacts from anon, authenticated;
revoke all on table public.whatsapp_messages from anon, authenticated;
revoke all on table public.whatsapp_broadcasts from anon, authenticated;
revoke all on table public.whatsapp_webhook_events from anon, authenticated;
revoke all on table public.whatsapp_opt_outs from anon, authenticated;

grant all on table public.whatsapp_contacts to service_role;
grant all on table public.whatsapp_messages to service_role;
grant all on table public.whatsapp_broadcasts to service_role;
grant all on table public.whatsapp_webhook_events to service_role;
grant all on table public.whatsapp_opt_outs to service_role;
grant usage, select on sequence public.whatsapp_messages_id_seq to service_role;
grant usage, select on sequence public.whatsapp_webhook_events_id_seq to service_role;

comment on table public.whatsapp_contacts is
  'Mirror of the WATI contact list. Only customers with accept_whatsapp = true are ever synced here.';
comment on table public.whatsapp_opt_outs is
  'Hard suppression list for WhatsApp broadcasts. Outranks customers.accept_whatsapp on every send.';
comment on column public.whatsapp_messages.click_count is
  'Fed by the Proto tracked redirect (api/wa-click.js). WhatsApp does not report link clicks.';

-- ---------------------------------------------------------------------------
-- Click registration.
--
-- A read-then-write from the serverless function would lose concurrent clicks,
-- and a broadcast to 1 500 people produces bursts. Doing the increment in one
-- statement keeps the count exact and returns the destination in the same round
-- trip, so the customer's redirect stays fast.
--
-- SECURITY INVOKER (the default) — the redirect route uses the service role, and
-- nothing else may reach this function.
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_register_click(p_token text)
returns table (broadcast_id uuid, phone text, tracked_url text)
language plpgsql
as $$
declare
  v_now timestamptz := now();
begin
  update public.whatsapp_messages m
     set click_count = m.click_count + 1,
         first_clicked_at = coalesce(m.first_clicked_at, v_now),
         last_clicked_at = v_now
   where m.click_token = p_token
   returning m.broadcast_id, m.phone
    into broadcast_id, phone;

  if broadcast_id is null and phone is null then
    return;
  end if;

  select b.tracked_url into tracked_url
    from public.whatsapp_broadcasts b
   where b.id = broadcast_id;

  -- count_clicked is "unique recipients who clicked", so only the first click
  -- from a recipient moves it.
  update public.whatsapp_broadcasts b
     set count_clicked = (
           select count(*) from public.whatsapp_messages m
            where m.broadcast_id = b.id and m.direction = 'out' and m.click_count > 0
         )
   where b.id = broadcast_id;

  return next;
end;
$$;

revoke all on function public.whatsapp_register_click(text) from public, anon, authenticated;
grant execute on function public.whatsapp_register_click(text) to service_role;
