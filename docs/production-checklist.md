# Production readiness checklist

Last run: 2026-06-25 (production hardening branch).

## Build

| Check | Result |
|-------|--------|
| `npm run build` | ✅ Clean build |

## Environment (Vercel `protoportal-admin`)

See `scripts/env.example` for the full list. Required for production:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_STOCK_SUPABASE_URL`, `VITE_STOCK_SUPABASE_KEY`
- `OPENROUTER_API_KEY`
- `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`
- `CRON_SECRET` (Vercel cron auth)
- `ORDER_NOTIFY_SECRET` (fulfillment order links)
- `TRADE_REGISTER_SECRET` (optional; falls back to `ORDER_NOTIFY_SECRET` for `/api/trade-application-received`)

Optional: `ADMIN_DASH_KEY`, `IMAGE_GEN_CONCURRENCY`, R2 vars, OpenRouter model overrides. Image gen budgets are configured in Admin → Cost Tracking (no extra env vars).

## Auth

- **Client:** Supabase email/password login; allowlist in `src/lib/auth.js` (3 admin emails).
- **API:** `requireAdminKey` validates JWT or `x-admin-key`; fulfillment routes accept order tokens.
- **Cron:** `requireCronOrAdminKey` checks `CRON_SECRET`.

## Crons (`vercel.json`)

| Path | Schedule | Notes |
|------|----------|-------|
| `/api/brevo-sync` | every 15 min | CRM contact cache |
| `/api/purge-expired-staging` | 03:00 daily | Staged image cleanup |
| `/api/order-notify-sweep` | every 10 min | Re-fire incomplete new-order notifications |

All use `requireCronOrAdminKey` — failures return JSON `{ error }` without crashing the platform.

## Database migrations (manual)

Run on **stock Supabase** (`yiqsvwajozafvalwcero`):

- `migrations/032_disable_auto_oos.sql` — disable auto-OOS archive
- `migrations/033_image_gen_cost_source.sql` — cost_source column on image_gen_cost_logs
- Then: `node scripts/restore-auto-oos-to-live.mjs` — bulk restore legacy `auto-oos` rows

## PII

`data/proto-active-customers.json` — intentional seed data for Proto Active customers panel (~40k lines). Not customer-facing.

## Post-deploy smoke

- [ ] Admin login (allowlisted email)
- [ ] Product Manager: archive / make live
- [ ] Fulfillment: Victor gate on save + send
- [ ] Order confirmation email (no prices on customer copy)
- [ ] Trade signup → `POST /api/trade-application-received` sends 24h acknowledgment (after main portal wired)
- [ ] Apollo index rebuild
- [ ] Mobile: Admin + Fulfillment layouts
