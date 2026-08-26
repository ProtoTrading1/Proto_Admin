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
Email Analytics) · `site-content` (Featured + Specials + Banner Editor) ·
`analytics` · `pricing` · `team` (opens fulfillment team modal).

Removed features — do NOT reintroduce: **Apollo (the entire tab, engine and
docs)**, **WhatsApp/WATI outgoing messaging TO CUSTOMERS** (order alerts,
broadcasts, welcome messages, Intercom relay — the customer's
`accept_whatsapp` opt-in DATA stays), Cost Tracking, product approval tab,
reorder mode inside Product Manager, product-type dropdown in the edit modal,
scheduled send for email broadcasts (immediate-send only).

**Exception — internal team WhatsApp.** Outgoing WhatsApp to the *fulfilment
team* is deliberate and supported: `api/order-team-whatsapp.js` broadcasts a
new order to the numbers in `fulfillment/users.json` via WATI. It is
internal-only and can never reach a customer number. Do not delete it as
"WATI leftovers".

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
