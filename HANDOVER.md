# Proto Trading — Session Handover

> Working notes for the next session. Covers both repos (admin dashboard + main
> portal), what shipped, the architecture/contracts you must not break, known
> caveats, and process conventions. Everything referenced here is **merged to
> `main` and deployed** on both repos.

---

## TL;DR
Long multi-part session across **two repos**. Themes: customer/email flows, the
order-confirmation PDF, image-replace robustness, an adversarial multi-agent
code review (6 real bugs fixed), a cross-repo **category/product contract
audit**, and Add-customer + registration-email fixes. No work is mid-flight;
both local branches sit on clean merged `main`.

---

## 1. Repos, branches, environment

|              | Admin                                   | Portal                                  |
|--------------|-----------------------------------------|-----------------------------------------|
| Repo         | `ProtoTrading1/Proto_Admin`             | `ProtoTrading1/ProtoMainSite`           |
| Prod         | admin.proto.co.za (Vercel)              | proto.co.za / register.proto.co.za      |
| Work branch  | `claude/admin-dashboard-features-uo74sl`| `claude/live-mirror-fixes`              |
| Local path   | `/home/user/protoportal-admin`          | `/workspace/proto-website-` (added via `add_repo`) |
| `main` HEAD  | `4c6f918` (#128)                        | `40771b5` (#134)                        |

**Environment caveats:**
- **No production secrets in this container** (`VITE_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_DASH_KEY`, `BREVO_API_KEY`, `CRON_SECRET`
  all unset). Cannot query prod Supabase / Brevo / authed APIs from here. Verify
  sends & data via the admin UI (Email Analytics).
- Two Supabase projects: **portal** (`VITE_SUPABASE_URL` — customers, orders,
  site-config bucket) and **stock** (`VITE_STOCK_SUPABASE_URL` — website_stock,
  archived_products).
- Chromium: `/opt/pw-browsers/chromium*/chrome-linux/chrome` (PDF/HTML
  screenshots). `pymupdf` installed for rasterizing PDFs. Use `esbuild` to bundle
  ESM for quick node tests (extensionless imports don't resolve under bare node).

---

## 2. What shipped this session (by theme, with PRs)

**Customer codes / confirmation email**
- **#111** — Confirmation email fires on **code assignment** (empty→valid 6-char
  on an approved customer), not on plain approval. Approval no longer requires a
  code (row + drawer). `justGotCode` gate in `api/admin-customers.js`.

**Emails / registration**
- **#112** — Branded dark-theme **"Application Approved"** HTML email on
  trade-application submit (`api/trade-application-received.js` +
  `lib/trade-application-email.mjs`).
- **#122** — **"Specific people"** email send: paste/type emails in
  `CustomerEmailModal`; backend `fetchRecipientsByEmail` personalizes known
  customers. Immediate-send only.
- **Portal #133** — register.proto success page: "Your trade account is live.
  We'll notify you as soon as the site is launched." (no email promise).
- **Portal #134** — Signup emails (`register-trade.js`): removed **all "log in
  now"** language (site isn't launched). Approved/10000-club email → subject
  *"Your Proto Trading Online trade account is approved"*, body = approved +
  "we'll notify you at launch". "Application received" email login line softened.

**Order confirmation PDF**
- **#113** — Rebuilt `src/lib/orderDocuments.js` to the **packing-slip layout**:
  PROTO TRADING **ONLINE** banner, shipping-method banner ("Proto to Quote
  Delivery" / "In store pick up" via `pdfShippingMethod`), Invoice-To +
  Delivery-Address blocks, columns **# · Image · Barcode · Product · Qty ·
  Avail**, per-page header redraw, `pdfSafeText` for `→`/smart quotes. Helpers in
  `lib/order-format.mjs`.

**Archive / Product Loader / Image Replace**
- **#116** — Archived code edits no longer 409 ("Destination category changed")
  — archived rows never send their synthetic category path (selectors hidden for
  archived). Positill relink broadened to any zero-stock archived row on code
  change. Folder publish + archive parallelized (`runWithConcurrency`, 5 at a
  time) — was 20 min sequential.
- **#119** — Image replace matches a labelled file by **SKU or barcode/code**
  (client `buildPreflightMatch` + server `bulk-image-replace.js`).
- **#120** — Image replace **cache-busts** the stored URL (`?v=timestamp`) so the
  new image shows, and previews the result thumbnail.

**Make-live + scheduling + UI**
- **#121** — Make-live modal refreshes taxonomy on open (fixes 409 after
  renames) + Child 2–4 subcategory pickers; schedule calendar → in-view upward
  popover (was clipped off-screen); Scheduled tab polls 30s + Refresh.
- **#109 / #110** — Toolbar declutter (ActionMenu) on Customer Management,
  Orders, Product Manager.

**Add customer (end-of-session)**
- **#125** — `AddCustomerModal` **eager-loaded** (not lazy) so it can't trigger a
  stale-chunk page reload; `.adm-modal--form` capped + body scrolls.
- **#126** — Visual redesign (icon chips per section, header subtitle).
- **#127** — Inputs used undefined class `adm-input` → `adm-field-input` (were
  tiny); pre-reg `account_code` sent `''` not `null`.
- **#128** — Fixed **all** NOT-NULL columns on `proto_active_customers` manual
  add: `account_code`=`''`, `name`=`name||email`, `sales_last_12_months`=`0`.

**Adversarial review + contract audit**
- **#124** — 17-agent adversarial review; fixed **6 verified bugs** (see §4).
- **Portal #132** — New Arrivals contract fix (see §3).

---

## 3. Key architecture & contracts (don't break these)

**Admin↔portal category/product mirror — audited clean this session:**
- Shared `lib/mottaro-category.mjs` is **byte-identical** in both repos, hash
  **`702c264b95de85b8`**, pinned in *both* `scripts/qa-smoke-check.mjs`. **Edit
  both copies together + update both hash pins.**
- `labelToSlug` (category-id derivation) and `resolveNavPathForProducts` (sort/
  count key) are **identical** across repos. Category ids are slugs derived from
  labels; **rename keeps the id stable** (only the label changes).
- Sort orders: site-config `sort-orders/orders.json`, keyed by `categoryKey`;
  admin writes (`category-sort-order.js`), portal reads (`sort-orders.js`).
- Motarro suppression: both read `taxonomy/mottaro-hidden.json` via
  `injectMotarroIntoTree`.
- **New Arrivals (fixed #132):** admin "Add to New Arrivals" writes
  `is_new_arrival`; portal `api/products.js` now selects it and maps
  `isNew: !!row.is_new_arrival` (was hardcoded `false` → New Stock collection was
  always empty). The category-page "New Arrivals" strip still uses `created_at`
  recency (separate).

**Customer rules (CLAUDE.md):**
- Customer codes are **NEVER auto-generated** — null or admin-typed 6-char only.
  Approval doesn't require a code.
- 10000-club = `proto_active_customers` allowlist; on signup they auto-approve +
  get "10000 club" tag + the approved email (`register-trade.js`).
- Per-customer last-email: `customers.last_email_type` + `last_email_at`
  (**migration 042** — must be applied in the portal Supabase).

**Chunk-reload recovery:** lazy chunks that 404 after a deploy trigger
`lazyRetry` → one-shot `window.location.reload()` (self-heals; `index.html` is
`no-cache`). `clearChunkReloadGuard` runs post-mount (`Root.jsx`), not at boot
(#124). A stale tab can "just refresh" on a lazy modal — a hard refresh fixes it.

---

## 4. Bugs fixed by the adversarial review (#124)
1. **HIGH** — Scheduled email + WhatsApp crons could **double-send to the whole
   audience** (`claimed` survived optimistic-lock retries). Fixed by resetting
   `claimed=null` at the top of the mutator in `run-scheduled-emails.js` **and**
   `run-scheduled-broadcasts.js`.
2. **MED** — "Send test" in Specific-people mode emailed the first typed customer
   → now always to `adminEmail`.
3. **MED** — Archived-row Positill relink overwrote admin-typed name/description
   on the same save → guarded with `adminSetName`.
4. **MED** — Image-replace identifier map let a barcode shadow a real SKU →
   two-pass (SKUs first) in `bulkImageReplace.js`.
5. **LOW** — Folder progress could read "11/10" → clamped.
6. **LOW** — Folder Archive run didn't track elapsed time → mirrored publish
   timing.

Reusable approach: `Workflow` tool, fan out reviewers per area → adversarially
verify each finding (default `real=false`) → keep only confirmed. **Workflow
requires explicit opt-in** ("ultracode" or the user asking); it's off by default.

---

## 5. Outstanding / to-verify / known caveats
- **Migration 042** (`last_email_type`/`last_email_at` on `customers`) — user ran
  it; if last-email badges look empty, re-verify with an
  `information_schema.columns` query.
- **Optional:** `WEBHOOK_SECRET` in Vercel + `?secret=` on the Brevo webhook to
  lock down open/click tracking (works without it, with a warning).
- **9am scheduled email** — user confirmed it sent. No action.
- **Speed** — obvious wins already in (React Query caching, code-split, chunking,
  cache-bust removal). Deeper pass needs the user to name the *specific* slow
  interaction. Product Manager is kept mounted (hidden via CSS) by
  design.
- **Deploys need a hard refresh** — repeatedly the user saw "no change"/"still
  the bug" because their tab hadn't picked up the new bundle. Tell them to
  Cmd/Ctrl+Shift+R after a deploy.

---

## 6. Git & process conventions
- Develop on the designated branch per repo; **after each squash-merge**,
  `git fetch origin main && git checkout -B <branch> origin/main` to restart
  clean; push with `--force-with-lease=<branch>:<remote-tip>` (tip via
  `git ls-remote origin <branch>`).
- Commit trailers required:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01TSay8R929BQFdjbUfUqHr8`.
- **Do NOT** amend the "unverified commit" the stop-hook flags after each merge —
  it's GitHub's own squash-merge commit (`noreply@github.com`), not a local
  commit. Amending = rewriting merged `main`. Just report and move on.
- Every code change: `npm run build` + `node scripts/qa-smoke-check.mjs` (both
  repos) and add an assertion for the fix. Portal build is rolldown-vite.
- GitHub via `mcp__github__*` tools (no `gh` CLI). Squash-merge PRs. Model
  identifier must never appear in commits/PRs/artifacts.
- User is action-oriented and dislikes questions/hedging — act on sensible
  defaults, verify visually when possible (render screenshots), keep replies
  tight.

---

## 7. Suggested next steps
- Run the same adversarial review over the **portal** repo (only the admin side
  was deeply reviewed).
- If slowness is reported, get the specific tab/action and profile that path.
- Register **page** and **email** now both say "notify at launch, no login" —
  re-check once seen live.
