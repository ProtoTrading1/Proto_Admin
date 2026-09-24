# Proto Admin Portal

Standalone admin app for Proto Trading. **Not** the main trade portal.

- **Repo:** https://github.com/ProtoTrading1/Proto_Admin
- **Production:** https://admin.proto.co.za (Vercel project `protoportal-admin`)
- **Main portal (separate):** https://github.com/ProtoTrading1/ProtoMainSite

## Stack
- Vite + React (JSX)
- Supabase via `api/_site-config.js`
- Vercel serverless `api/` routes
- npm

## Dev
```bash
npm run dev
npm run build
```

## Structure
- `src/pages/AdminPage.jsx` — all admin sections
- `src/components/` — ProductManagerEngine, ReorderGrid, etc.
- `src/lib/` — products, taxonomy, customers, orders
- `api/` — serverless backend

## Sections (nav ids)
`orders` (Order Requests, incl. Order Workspace) · `product-loader` ·
`image-replace` · `catalogue` (Product Manager, live only) · `archive`
(archived products, no category sidebar) · `reorder` (Reorder Grid) ·
`customers` · `comms` (Email CRM: Brevo-synced contacts + broadcast composer +
Email Analytics) · `whatsapp` (WhatsApp CRM: WATI broadcasts, delivery/click
analytics, opt-outs) · `site-content` (Featured + Specials + Banner Editor) ·
`analytics` · `pricing` · `team` (opens fulfillment team modal).

Removed features — do NOT reintroduce: **Apollo (the entire tab, engine and
docs)**, **WhatsApp order alerts to customers**, **WhatsApp welcome messages**,
**the WhatsApp Intercom relay** (inbox / two-way chat), Cost Tracking, product
approval tab, reorder mode inside Product Manager, product-type dropdown in the
edit modal, scheduled send for email broadcasts (immediate-send only).

**Exception — internal team WhatsApp.** Outgoing WhatsApp to the *fulfilment
team* is deliberate and supported: `api/order-team-whatsapp.js` broadcasts a
new order to the numbers in `fulfillment/users.json` via WATI. It is
internal-only and can never reach a customer number. Do not delete it as
"WATI leftovers".

**Reinstated 2026-09-24 — consented WhatsApp marketing.** The `whatsapp` tab
sends WATI template broadcasts to customers, which the old blanket ban
disallowed. It is scoped, not a return of the removed feature: opt-in only,
approved templates only, opt-outs enforced server-side. See "WhatsApp CRM"
below. Order alerts, welcome messages and the Intercom relay stay removed.

## Customers & email
- **Customer codes are NEVER auto-generated** — always null or an admin-typed
  6-char code. Approval does **not** require a code (allocate later).
- **10000 club** = pre-registered emails (`proto_active_customers` allowlist)
  with a **non-empty account_code** (migration 054 — a blank-code row never
  auto-approves). On signup they auto-approve, get the `10000 club` tag, and
  are sent a **welcome email** (`api/_welcome-email.js`).
- **Manual add-customer**: POST `api/admin-customers` with a `section`
  (`approved` / `approved-10000` → creates auth acct + welcome email;
  `pre-registration` → allowlist). Never trade-requests, never a code.
- **Per-customer last email**: `customers.last_email_type` + `last_email_at`
  (migration 042), stamped by `api/_customer-email-status.js` on every send;
  shown as a badge in Customer Management.
- **Per-template test send**: `api/email-test-send.js` (welcome, campaign,
  order_confirmation, trade_application) → `EmailTemplateTests` in the email modal.
- **Brevo analytics**: opens/clicks flow via `api/brevo-email-webhook.js`. Set
  `WEBHOOK_SECRET` in Vercel and configure Brevo to send the same value as the
  `X-Webhook-Secret` header (or Bearer token). The endpoint fails closed when
  the secret is absent or incorrect.

## WhatsApp CRM (`whatsapp` tab)

Consented WhatsApp marketing through WATI. Migration `070_whatsapp_crm.sql`
extends the `whatsapp_*` tables that survived migration 055 and adds
`whatsapp_opt_outs`.

**The consent rule — three conditions, all required, re-checked server-side on
every send including "selected contacts":**

1. `customers.accept_whatsapp = true`
2. the number normalizes to a valid one (`api/_whatsapp-phone.js`)
3. no row in `whatsapp_opt_outs`

`api/_whatsapp-audience.js` is the only place that answers "may we message this
person?". A phone list from the browser is a **filter over** the eligible set,
never the set itself — a stale tab cannot reach someone who opted out. The
resolver also backs the Contacts list and the dashboard, so the audience count
on screen is the count that gets messaged.

**Broadcasts are always approved WATI templates.** Outside a 24-hour
customer-initiated window WhatsApp silently drops non-template messages, so a
free-text composer would report 1 500 successful sends that nobody received.
`api/whatsapp-templates.js` only offers templates WATI reports as `APPROVED`.

**Click analytics are ours, not WhatsApp's.** WhatsApp reports delivered and
read; it has no click webhook. A broadcast whose parameter contains `{{link}}`
gets a per-recipient tracked link (`api/wa-click.js` → 302), so Analytics can
name who clicked. The redirect is public by design (the clicker has no admin
session) and is not an open redirect — the destination comes from the broadcast
row.

**Opt-outs arrive three ways** and all land in `whatsapp_opt_outs`:
a customer replying STOP/unsubscribe (`api/wati-webhook.js`), a customer
switching broadcasts off inside WhatsApp (read back by `api/whatsapp-sync.js`,
which is why the pull half of the sync is not optional), and an admin adding one.
Lifting an opt-out is **owner-only**.

Files: `api/_wati-client.js` (WATI HTTP — deliberately separate from
`_wati-notify.js`, the team alert), `api/_whatsapp-audience.js` (consent gate),
`api/_whatsapp-broadcast.js` (send runner), `api/_whatsapp-phone.js`
(normalization), routes `whatsapp-{dashboard,contacts,templates,broadcast,sync,opt-outs}.js`,
`wati-webhook.js`, `wa-click.js`; UI `src/components/WhatsappPanel.jsx` +
`src/components/whatsapp/`.

**Env vars (Vercel):** `WATI_API_TOKEN` (bearer JWT — expires, rotate it),
`WATI_API_URL` (defaults to the tenant URL), `WHATSAPP_WEBHOOK_SECRET` (send it
from WATI as `X-Webhook-Secret`; the webhook fails closed without it),
`WHATSAPP_CLICK_BASE_URL` (optional, defaults to `ADMIN_PUBLIC_URL`),
`WHATSAPP_CLICK_FALLBACK_URL` (optional, defaults to `https://proto.co.za`).
Cron: `/api/whatsapp-sync` every 3 hours, pushing up to 250 contacts per run.

## Auth

Supabase email/password login with a **3-email allowlist** (`src/lib/auth.js`, mirrored in `api/_admin-auth.js`):

- `danieljoffeinfo@gmail.com`, `george@proto.co.za`, `online@proto.co.za`

`Root.jsx` shows `AdminLoginPage` until `getVerifiedSession()` + `/api/auth-check` succeed. API routes use `requireAdminKey` (JWT or optional `ADMIN_DASH_KEY` header). Crons require `CRON_SECRET`.

### Fulfillment links (no login)

The packing team opens an order from WhatsApp with **no admin account**.
`api/order-team-whatsapp.js` sends `/f/<orderId>/<token>`, where the token is an
HMAC claim minted by `api/_fulfillment-token.js` (`FULFILLMENT_LINK_SECRET`,
falling back to `ADMIN_DASH_KEY` / `SUPABASE_SERVICE_ROLE_KEY`; TTL
`FULFILLMENT_LINK_TTL_DAYS`, default 30). Rotating that secret invalidates every
outstanding link.

`resolveRequestAuth` returns `{ type: 'order', orderId }` for a valid token, and
every route that accepts one scopes its work to that single order. A link may:
view its order, tick items packed, edit quantities, mark out of stock, swap
products (`api/fulfillment-product-search.js`), add notes, and save that packing
work. A link may **not**: email a customer (`send-order-email.js`), advance to
`order sent` or `payment received` (`_fulfillment-auth.js`), write money columns,
or reach `order-notification.js` / `order-notify-log.js` — those need a signed-in
owner. Team phone numbers are stripped from `fulfillment-users` for link callers.

## Agent skill
See `.cursor/skills/protoportal-admin/SKILL.md` for full architecture.

**Never** implement admin features in protoportal-main's deprecated embedded AdminPage.

## Mandatory change journal

Every change to code, configuration, dependencies, database migrations, automation,
or deployment behaviour must be recorded in `md/changes/YYYY-MM-DD.md` before the
work is considered complete.

- Use the actual calendar date and append to that day's file; do not overwrite
  earlier entries.
- Each entry must include: time, summary, files or systems affected, verification
  performed, deployment status, and commit or PR reference when available.
- Record database and Vercel changes as well as repository edits.
- Never place passwords, API keys, tokens, customer personal data, or other secrets
  in the journal.
- Documentation-only journal updates do not require a second journal entry.
