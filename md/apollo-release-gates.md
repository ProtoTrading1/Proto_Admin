# Apollo release gates

This checklist is the release authority for Apollo. A passing build or a visible
screen is not enough to release. Every gate needs recorded, dated evidence from
the isolated preview before the corresponding production switch can be enabled.

## Data and identity

- [x] Apollo test database is separate from the portal and contains no copied
  production customer data.
- [x] Activity, retention and memory schema use RLS and service-role-only
  grants in the test database.
- [x] Memory append/read and activity retention functions were exercised in
  rolled-back test transactions; no temporary records persisted.
- [x] The owner Pulse retrieves approved memory read-only with reviewer,
  version and evidence references, and exposes bounded pagination.
- [ ] A real authenticated portal test user can write activity to the isolated
  database, proving the portal UUID identity contract.
- [ ] A non-owner authenticated user is denied owner reports and memory.
- [ ] The preview uses only dedicated Apollo service credentials, never a
  portal-database fallback; secrets are server-only.

## Activity and customer reporting

- [x] Browser collection defaults off and submits no customer identity.
- [x] Main and Instore use fixed server routes; server validates the source.
- [x] Completed search, deliberate product view, category view, basket add and
  interaction/visibility-limited active intervals have focused unit coverage.
- [x] Owner reporting is wired to the dedicated Apollo activity database with
  no portal-database fallback; `APOLLO_ACTIVITY_REPORTING_ENABLED` defaults off.
- [x] Incomplete collector coverage is explicitly `partial`, and partial
  intervals do not produce an engagement insight or a verified time total.
- [x] Pulse reads source-tagged Main/Instore searches, no-result searches,
  deliberate product views, category views and basket-add events from the
  isolated event store; legacy Analytics remains separate and source-unknown.
- [ ] Preview journey proves Main/Instore source separation, code search,
  misspelling, zero-result search, product click and subsequent basket add.
- [ ] Preview journey proves hidden tab, idle interval, logout and multiple-tab
  handling against database events and reporting output.
- [ ] Presence, recorded basket value and current section reconcile with
  controlled signed-in test sessions. Presence is labelled “recently active”,
  using the 150-second window, never real time.
- [ ] Reporting reads collection health and source-specific watermarks; gaps
  and stale sources are displayed rather than shown as zero.

## Website and Positill sales

- [ ] Treat all non-cancelled website order value as order pipeline, not
  payment-confirmed sales; reconcile payment timestamps/statuses before adding
  a paid-sales metric.
- [ ] Independently reconcile portal order totals/statuses/VAT basis for SAST
  day, Monday-start week, month and custom ranges, including cancellations and
  refunds, across a dataset beyond normal API page limits.
- [x] Keep the existing `sql-bridge.proto.co.za` Cloudflare route unchanged.
  The healthy `hermes-proto-bridge1` tunnel currently maps it to
  `http://localhost:8765` on BladeRunner-PC.
- [ ] Prove the existing bridge’s configured, authenticated health path through
  the normal admin server (not a browser-exposed bridge key), then inventory
  its existing approved reports. Do not replace, restart, reconfigure or make
  the bridge publicly less restrictive for Apollo.
- [ ] Using only existing approved reports, prove invoice header/line identity,
  document type, date/timezone, tax basis, credit treatment,
  customer/reference fields and pagination semantics. A missing field remains
  unavailable; Apollo must not add arbitrary SQL capability to the bridge.
- [ ] Reconcile website/POS transactions only by explicit reference. Show
  unmatched records and never infer a link from amounts or dates.
- [ ] Product rankings preserve variant/parent distinction and do not invent
  colour/design information absent from Positill.

## Operations and release

- [ ] Set isolated-preview flags and dedicated secrets only after the preceding
  gates pass. Confirm UI/API failures are non-blocking to search and checkout.
- [ ] Browser-test the owner Business Pulse, activity source/freshness labels,
  stale-last-success behaviour and database outage responses.
- [ ] Enable activity reporting only in the isolated preview after real owner
  sessions prove both source collectors and their continuous-coverage health.
- [ ] Record the exact production deployment/rollback target, then deploy the
  narrow candidate with all customer-facing flags initially disabled.
- [ ] Enable one source at a time after a controlled production test, monitor
  collection health and preserve evidence for the release record.

## Explicitly unavailable until gates pass

Apollo must answer **unavailable**—not zero or an estimate—for Positill sales,
website/POS reconciliation, active browsing time, Main/Instore search funnels,
customer-interest rankings and named current-section activity until their
relevant gates have passed.

## Confirmed database blockers (2026-09-15)

- Local Apollo reporting correction (not yet deployed): website order value now
  subtracts the recorded VAT-inclusive promotion discount, fails closed on
  malformed/negative amount data and unknown order statuses, and compares
  open day/week/month periods against the matching elapsed portion of the prior
  period. These are code/test results only; the dated production and preview
  reports have not yet been revalidated against source transactions.
- Latest local verification (2026-09-15): Apollo-focused tests pass 113/113,
  full admin lint passes, and production build passes. Full admin tests pass
  926/927; the remaining failure is the pre-existing email follow-up contract
  in `tests/email-campaign-follow-up.test.js` (stale “Bounced / excluded” copy
  assertion; actual audience eligibility also needs a separately scoped
  compliance review). The affected email behavior was not changed as part of
  Apollo.

- Apollo branch `apollo-business-pulse-20260912` is reported by Supabase as
  `MIGRATIONS_FAILED` (the preview project itself is `ACTIVE_HEALTHY`). Its
  ledger contains only four Apollo entries: `20260912211514` activity foundation,
  `20260912211621` activity retention, `20260912211840` memory revisions, and
  `20260912215113` memory read pagination. The matching local migration files
  use versions `20260912211154`, `20260912211546`, `20260912211739`, and
  `20260912235000`, respectively. The Apollo branch has nine public tables and
  `with_data: false`. This is a separate Apollo event/memory store, not the
  portal data source; portal orders, analytics, customers, baskets and presence
  must continue to be read from the portal database, never copied into Apollo.
  A read-only schema check found the required Apollo tables/RPCs on the branch,
  but its `MIGRATIONS_FAILED` status and SQL equivalence still need diagnosis.
  Do not reset or rebase it until Supabase's first failed migration is identified.
- The Supabase MCP has no branch-workflow log reader. A read-only attempt to
  query Supabase project health through the connected Management API was
  rejected with HTTP 403; it did not return migration logs. Desktop browser
  automation also failed to initialize again on 2026-09-15. A Git audit found
  all four local Apollo migration files were introduced together with no rename
  history, and local/remote preview HEADs have identical trees despite distinct
  commit IDs. The version mismatch does not identify the failure cause; do not
  rename or rewrite migrations. Obtain the exact first failed
  migration statement from Supabase Dashboard → Manage Branches → Apollo
  branch → View Logs before altering migration history or trying to
  rebase/reset.
- Current Vercel state was rechecked on 2026-09-15: Apollo preview
  `protoportal-admin-ax7l6jisn-proto-team.vercel.app` is READY on remote commit
  `ac54b94a58d20f6f1c5e8f770baa331bff46a17a`. The local and remote committed
  trees match, but additional local uncommitted Apollo changes are not in this
  deployment. Production alias `admin.proto.co.za` currently points to
  promotion `dpl_3PhNAoQGXsn6ZgqUXcPns5y2U8k1` (source deployment
  `dpl_FGSkB47YX2Xc6itXwr3HgqxvFtn6`); that source has no Git commit metadata.
  No Apollo changes have been promoted to production.
- Read-only checks confirmed the Apollo event, collection-health, monthly and
  memory tables exist with RLS enabled; the append/read/retention RPCs exist.
  Public and authenticated roles have no table access; service-role grants are
  present. This confirms database objects, not Data API reachability: the
  exposed-schema setting was not available from SQL and preview-secret endpoint
  access has not been exercised.
- Rechecked on 2026-09-15 with `has_table_privilege` and
  `has_function_privilege`: all four Apollo tables and `customer_presence`
  grant no table privileges (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
  TRIGGER) to `anon` or `authenticated`. Service-role table grants are present.
  The append-memory, read-memory and retain-activity RPCs are executable by
  `service_role`; Apollo functions are not executable by the public client
  roles, and the immutable trigger function is not executable by API roles.
  These checks passed in the isolated branch only.
- The isolated branch's current `customer_presence` table contains
  `customer_id` and `last_seen_at` but not `current_section`; migration 069 is
  still not applied there. Production remains unchanged.
- Supabase security advisors report RLS-enabled tables without policies. That
  is intentional for the Apollo tables only if they remain inaccessible to
  `anon`/`authenticated` and are used solely by owner-checked server routes;
  reverify both conditions before enabling a preview endpoint.
- The production `customer_presence` schema has `customer_id`, `last_seen_at`,
  `session_id` and `first_seen_at`, but no current-section field. A local,
  additive portal migration and coarse-section heartbeat are now authored;
  they have not been applied. Apollo must continue to show current section as
  not collected until the migration is safely applied and a controlled session
  verifies the write and owner-only read.
- The retention RPC exists and passed isolated tests. Local Vercel config now
  includes a daily 03:30 SAST cron, using Vercel's bearer `CRON_SECRET`; the
  feature still defaults off. This schedule is not deployed or confirmed in
  Vercel, and must be exercised against the isolated database before enabling
  collection.
- The latest production deployment of `admin.proto.co.za` is a Vercel
  promotion of a CLI-created preview with no recorded Git commit SHA. Record
  that deployment ID as the rollback target; establish the intended production
  baseline commit before a new Apollo release.
- Authenticated preview access could not be exercised this session: Vercel's
  protected-deployment share URL could not be created, and the desktop browser
  automation runtime failed to initialize. No conclusion is made about signed-
  in UI behavior or preview environment values.

### Fresh revalidation (2026-09-15, 20:50 SAST)

- Supabase still lists `apollo-business-pulse-20260912` as
  `MIGRATIONS_FAILED`; its ledger remains at the same four versions listed
  above. `get_project` does not resolve the branch ref, but the read-only
  `list_tables` call does: the Apollo event, collection-health, monthly, and
  memory tables remain present, RLS-enabled, and empty. The branch's
  `customer_presence` still has no `current_section`. No reset, rebase, or
  schema write was attempted; the exact first SQL failure is still unknown.
- Vercel confirms the admin Apollo preview is still READY at deployment
  `dpl_9uSpCcEc8s9Jz2WcPUD5bSFrFNCR`, commit
  `ac54b94a58d20f6f1c5e8f770baa331bff46a17a`. Current local Apollo changes
  remain uncommitted and are not in that preview. `admin.proto.co.za` still
  points to promotion `dpl_3PhNAoQGXsn6ZgqUXcPns5y2U8k1`; production was not
  changed.
- Current verification: Apollo admin focused suite passes 113/113; full admin
  suite passes 926/927, with the sole failure still the unrelated email
  follow-up label assertion. Admin ESLint passes and the production Vite build
  passes using Vite's runner config loader. Storefront full tests pass 382/382,
  focused activity/API/presence tests pass 31/31, and the Vite build passes.
  Storefront ESLint remains red on three unused symbols in
  `api/extended-range.js` and `src/components/ExtendedRangePage.jsx`; these
  were not changed as part of Apollo.
- No code was pushed or deployed, no environment value was changed, and no
  production or Apollo database migration was applied. The remaining database
  diagnosis requires the first failing statement from the branch's Supabase
  **View Logs** page; migration history must not be altered before that evidence
  is available.

### Revalidation after local reliability fixes (2026-09-15, 21:02 SAST)

- Supabase branch inventory is unchanged: `apollo-business-pulse-20260912`
  remains `MIGRATIONS_FAILED`, with `with_data: false`; the main portal project
  is `ACTIVE_HEALTHY`. The branch ref lists the four Apollo migration ledger
  entries and `list_tables` confirms the Apollo event, collection-health,
  monthly, and memory tables are RLS-enabled and empty. Its
  `customer_presence` still lacks `current_section`. `get_project` does not
  resolve the branch ref, and the connected Supabase tools offer no branch-log
  reader; no migration or schema write was attempted.
- Vercel read-only checks confirm `admin.proto.co.za` still targets READY
  promotion `dpl_3PhNAoQGXsn6ZgqUXcPns5y2U8k1`, whose source deployment is
  `dpl_FGSkB47YX2Xc6itXwr3HgqxvFtn6`. The latest READY Apollo preview remains
  `dpl_9uSpCcEc8s9Jz2WcPUD5bSFrFNCR` at commit
  `ac54b94a58d20f6f1c5e8f770baa331bff46a17a`; it does not contain the
  current local candidate. Local admin HEAD is `7fd1a8d071904d567c8f5e277b539606a46bf2fe`,
  one commit ahead and one behind its branch remote, with uncommitted changes.
- Admin Apollo-focused tests now pass **114/114**. The full admin suite is
  **927/928**: its sole failure is the out-of-scope email-campaign follow-up
  label assertion. Admin ESLint and production Vite build pass. The latest
  storefront evidence remains **382/382** tests and a successful production
  build; its lint still reports three unused-symbol issues outside Apollo.
- Day/week comparison fixtures now prove the matching elapsed portion of the
  previous calendar period. The Positill raw-evidence adapter now refuses the
  bridge's `today` aggregate unless Apollo's requested window is exactly the
  current SAST day-to-date window. These are local-only changes and are covered
  by the passing focused suite.
- The Pulse UI now titles that feed `Positill report evidence (not verified
  sales)` to prevent the raw aggregate from being mistaken for confirmed sales;
  a component regression protects the wording.
- Release remains blocked on the exact first failed Supabase migration log,
  trustworthy Positill VAT/document/credit/reference semantics, verified
  preview environment flags and authenticated owner/non-owner end-to-end
  checks, and reconciling the feeds. No push, deploy, promotion, environment
  change, database mutation, or live-site change occurred.

### Follow-up data-contract audit (2026-09-15, 21:10 SAST)

- Fixed an engagement-insight contract bug: the decision layer had read legacy
  `customers`/`recordedVisits` fields, while the activity reader returns
  `activeCustomers`/`activeSeconds`. It now only emits a complete-evidence
  insight when both current-contract counts are valid. Regression covers the
  real reader shape, stale field names, null and invalid counts.
- The Pulse heading now identifies Positill output as `Positill report
  evidence (not verified sales)`, with a component test protecting that
  distinction.
- Fixed Instore category-interest capture in the storefront: category views
  now use the active Main/Instore source instead of being recorded only for
  Main. Storefront full suite passes **383/383** and production build passes;
  Apollo-focused admin tests pass **115/115**, admin ESLint passes, and admin
  production build passes.
- Remaining known limits from read-only code audit: no monitor advances
  `complete_since` in `apollo_collection_health`, so complete activity coverage
  remains unavailable; anonymous aggregate activity is not implemented;
  cross-tab attribution is per tab; POS authentication/configuration and
  document/tax semantics are unverified. Owner-only memory authoring is now
  present in the local candidate, but it has not been deployed or tested
  against the isolated database. A constrained local “Ask Apollo” question layer now formats only the
  owner-only pulse reports already loaded for the selected period. It performs
  no external AI call, persists no prompt, refuses unsupported/forecast
  questions, and labels partial evidence. It is not yet authenticated-preview
  verified and is not a general-purpose conversational agent. No remote or
  production changes.

### Revalidation after Apollo Q&A and migration-ledger check (2026-09-15)

- Fixed a misplaced test assertion in the new constrained Ask Apollo tests.
  Apollo-focused suite passes **127/127**. Admin ESLint passes and the Vite
  production build passes. The full admin suite is **940/941**; its only
  failure is the pre-existing `tests/email-campaign-follow-up.test.js` source-
  copy assertion for `Bounced / excluded`. No email campaign behavior was
  changed.
- A fresh Supabase branch inventory still reports
  `apollo-business-pulse-20260912` as `MIGRATIONS_FAILED`, while the branch's
  `supabase_migrations.schema_migrations` read-only query shows all four
  Apollo migration entries present. Their recorded versions are
  `20260912211514`, `20260912211621`, `20260912211840`, and `20260912215113`.
  This confirms ledger entries exist; it does **not** establish why Supabase
  marks branch provisioning failed or prove migration/source equivalence.
- The Management API branch/log connector returned HTTP 403 because its OAuth
  token lacks the `Environment:Read` scope. Browser automation also failed to
  initialize, so the first failed statement is still unavailable. Do not reset,
  rebase, rerun, rename, or rewrite migrations until the first failure is
  obtained from Supabase Dashboard → Manage Branches → Apollo branch → View
  Logs (or the connector is reauthorized with the required read scope).
- The migration files were briefly renamed locally to test whether matching
  ledger versions was the right next step, then immediately restored after
  checking this release gate. Their tracked paths/content are unchanged and no
  Supabase mutation occurred.
- Production remains unchanged. No changes were pushed or deployed, and no
  database/environment changes were made. The branch's migration failure,
  data-source reconciliation, preview owner/non-owner tests, and the remaining
  release gates above still prevent a safe live release.
- Added a local, owner-only memory revision editor and an explicit management
  read view. Drafts and prior revisions remain visible only to the owner; the
  existing answer/read path continues to expose only the latest approved
  revision. New revisions carry evidence references and a server-derived
  reviewer; database version checks remain authoritative. Regression coverage
  proves form submission and management-view filtering. This is still a local
  candidate, not an available production capability.
- Latest admin evidence after that change: Apollo-focused tests pass
  **131/131**; lint and production build pass. Full suite is **944/945**, with
  the same unrelated email follow-up copy assertion as the only failure.
- Hardened Apollo's Positill path: Apollo now requires both the authenticated
  bridge URL and bridge key before invoking the shared legacy fetcher. This
  prevents Apollo from using that fetcher's direct-MSSQL fallback when the
  approved bridge is absent. The permanent bridge and existing SQL endpoint
  were not changed. Regression proves a missing bridge prevents any call.
- Storefront activity endpoint/queue/lifecycle/session/category-source tests
  pass **39/39** in the local candidate, including Main/Instore separation,
  server-derived identity, bounded retries, and visible/interaction-limited
  active intervals. These changes are uncommitted and have not been deployed.
- Supabase still reports the Apollo branch as migration-failed. The existing
  connected account still lacks `Environment:Read`; the additional connection
  did not become active, so no branch logs were retrieved. This remains an
  external authorization prerequisite, not a reason to modify migration
  history speculatively.
- No push, preview deployment, secret change, database write, or production
  change occurred in this work period.
- Read-only revalidation of the Apollo branch confirms the four Apollo tables
  have RLS enabled, no client-role table privileges for `anon` or
  `authenticated`, and service-role SELECT grants. The Supabase security
  advisor reports `RLS Enabled No Policy` for these tables (and five portal
  tables); for Apollo this is intentional defense-in-depth only while public
  and authenticated grants remain revoked and routes perform owner checks.
  The unused customer-period index is expected before any activity data exists.
- Spot-checked database definitions for `apollo_append_memory`,
  `apollo_read_memory`, `apollo_retain_activity`, and the immutable trigger
  against the local migration SQL: expected signatures/behaviors are present,
  functions are not `SECURITY DEFINER`, and service-role-only execute grants
  are recorded. `apollo_read_memory(NULL, 50)` executes successfully and
  returns zero rows, consistent with the empty test branch. This proves schema
  functionality for that RPC, but does not explain the branch's failed
  provisioning status.
- A fresh branch inventory still reports
  `apollo-business-pulse-20260912` as `MIGRATIONS_FAILED` while its preview
  project is `ACTIVE_HEALTHY`. The Management API connection still lacks
  `Environment:Read`, the attempted additional connection remains
  `initializing`, and the branch-log query remains unavailable. The first
  failed migration statement is still required before any history repair.

### Read-only release recheck (2026-09-16)

- Supabase still reports the Apollo test branch as `MIGRATIONS_FAILED`, with
  preview project status `ACTIVE_HEALTHY`. Its four migration ledger entries
  remain present. The live parent database lists no `public.apollo_%` tables;
  the isolated branch lists the four Apollo event, health, monthly and memory
  tables. No production schema change has been applied.
- The currently active Supabase Management API connection still returns HTTP
  403 for the branch-log endpoint. A fresh read-only diagnostics connection
  was initiated and is awaiting owner authorization; no database changes are
  requested by that link. Do not repeat or repair migrations until the first
  failed migration statement is visible.
- Vercel confirms the latest admin Apollo preview is READY at
  `protoportal-admin-ax7l6jisn-proto-team.vercel.app`, commit
  `ac54b94a58d20f6f1c5e8f770baa331bff46a17a`. Local admin HEAD is
  `7fd1a8d071904d567c8f5e277b539606a46bf2fe`, one commit ahead and one behind
  its branch remote, with uncommitted Apollo changes; that preview therefore
  does not verify the current local candidate. The storefront activity preview
  `protoportal-main-kbickrm1c-proto-team.vercel.app` is READY at commit
  `ee5c87916ac118dc5cb67b87fb906050658948e0`; its local candidate also has
  uncommitted changes and is not represented by that deployment.
- No code was pushed, preview deployed, environment secret changed, database
  mutated, or production alias changed during this recheck. Remaining release
  gates are the branch failure diagnosis, clean/current preview deployments,
  authenticated owner/non-owner verification, approved bridge access and
  evidence, and independent transaction reconciliation.
- Local-only reliability improvement: the authenticated Main/Instore event
  intake now advances `last_successful_at` only after the event write succeeds,
  records a failed write and clears any prior `complete_since`, and leaves
  continuity unverified. This surfaces collector freshness without treating
  one successful event as proof of complete customer coverage. The browser now
  sends bounded per-source batches instead of one request per event; the API
  validates a whole batch and performs an idempotent bulk insert. Combined
  activity API, transport and journey-lifecycle tests pass 42/42; the
  deployment and isolated-database behavior remain unverified.
- Local-only order-value clarification: Apollo now labels website-order
  position as `Order flow`, shows status counts, and explicitly warns that the
  displayed value includes all non-cancelled stages and is not
  payment-confirmed sales. Positill invoiced sales remain a separate
  unverified feed; no paid-sales amount has been inferred from order status.
  Signed-in preview verification is still required.

### Apollo continuation validation (2026-09-16)

- All 14 Apollo admin suites pass locally: **132/132 tests**. The UI fixture now
  includes the order-flow insight that the test asserts; the independent
  website order detail continues to disclose order stages and does not call
  them paid sales.
- The storefront suite passes **389/389 tests**. The admin Vite production
  build and targeted Apollo ESLint checks pass. The full admin suite is
  **945/946**: its only remaining failure is the unrelated existing
  `email-campaign-follow-up.test.js` expectation for a bounced-recipient label.
- Supabase branch inventory still marks the isolated Apollo branch
  `MIGRATIONS_FAILED` while its preview database is `ACTIVE_HEALTHY`; four
  migration versions are recorded. The narrow Management API log query for
  the branch's creation/migration window returned HTTP 403. Do not alter
  migration history until the first failing statement is available.
- No preview deployment, push, database change, environment change, or
  production change was performed. Preview E2E and all data-source/security
  gates remain open.

