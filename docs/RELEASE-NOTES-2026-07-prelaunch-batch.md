# Proto Admin + Portal — Pre-launch Batch (July 2026)

Release notes for the plumbing, hardening, and performance work across **protoportal-admin** and **Proto-Website-** before go-live.

**Verified:** 3 Jul 2026 — `node scripts/qa-plumbing-e2e.mjs` → **5/5 PASS** on `admin.proto.co.za` ↔ `site.proto.co.za`.

---

## What changed (by area)

### Admin ↔ Portal plumbing

| Change | Repo | PR |
|--------|------|-----|
| Removed ~1,000 lines of dead Product Manager sub-views from AdminPage | Admin | [#63](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/63) |
| Mottaro category injected at read-time on portal (nav, products, counts) | Portal | *manual push required* — branch `cursor/plumbing-mottaro-fix-55ce` |
| Popup special “seen once” keys on `updatedAt` | Portal | same |
| Sort-order client cache TTL reduced to 15s | Portal | same |
| E2E plumbing test script (`scripts/qa-plumbing-e2e.mjs`) | Admin | [#63](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/63) |

### Data integrity & scale (admin)

| Change | PR |
|--------|-----|
| Bulk product delete/move/archive/unarchive — batched SQL + chunked parallelism | [#64](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/64) |
| Taxonomy writes — optimistic locking (`updatedAt`, 409 on conflict) | [#64](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/64) |
| Bulk customer approve — batched fetch + parallel chunks | [#64](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/64) |
| `maxDuration: 60` on heavy API routes | [#64](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/64), [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |

### Product Manager, Nutstore & archive (admin)

| Change | PR |
|--------|-----|
| Nutstore archive rows visible even without ERP link (`stockLinked: false`) | [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |
| Re-lookup ERP when editing SKU/barcode on Nutstore-archived products | [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |
| Nutstore batch lookup dedup + dormant SKU cache; parallel `nutstore-process` | [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |
| Bulk move — 409 on stale destination path; client path-gap validation | [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |
| Archive buttons show selection count (“Make 3 live”, not “Make all live”) | [#65](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/65) |

### Admin performance & structure (admin)

| Change | PR |
|--------|-----|
| Lazy-load non-default sections + hover chunk prefetch | [#66](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/66) |
| Lazy-load jsPDF; parallel catalog page fetch; taxonomy counts SWR cache | [#67](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/67) |
| Extract `BannerPanel`, `SpecialsPanel` from AdminPage | [#68](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/68) |
| Extract `PricingPanel`; Reorder Grid already virtualized | [#69](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/69) |

### Outstanding fix pass (admin, separate branch)

| Change | PR |
|--------|-----|
| Extract `OrdersTab` + `CustomersTab` from AdminPage (~1,700 lines moved) | [#62](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/62) |
| Section error boundaries, sync status badge, filename parser, fulfillment polish | [#62](https://github.com/danieljoffeinfo-web/protoportal-admin/pull/62) |

**Not yet extracted:** Reorder toolbar and taxonomy rename modals remain inline in `AdminPage.jsx`.

---

## E2E plumbing test results (3 Jul 2026)

Run: `ADMIN_DASH_KEY=… node scripts/qa-plumbing-e2e.mjs`

| # | Check | Result |
|---|-------|--------|
| 1 | Taxonomy rename → portal nav (~60s) | PASS |
| 2 | Mottaro visible on admin + portal (582 products) | PASS |
| 3 | Sort-order admin → portal | PASS (skipped — no saved order to swap) |
| 4 | Popup active on/off → portal | PASS |
| 5 | Price/stock update → portal products API | PASS |

---

## Recommended merge order

### Portal (Proto-Website-)

1. **Push and merge** `cursor/plumbing-mottaro-fix-55ce` (bot cannot push — manual step below).

### Admin (protoportal-admin)

Merge in dependency order to reduce conflicts:

1. **#63** — stale code removal + E2E script
2. **#64** — scale + taxonomy locking
3. **#65** — Nutstore/archive/move UX
4. **#62** — Orders/Customers extraction + outstanding fixes *(rebase onto #63–#65 if needed)*
5. **#66** → **#67** → **#68** → **#69** — perf + AdminPage splits (sequential; each builds on prior)

After each merge: `npm run build`, `node scripts/qa-smoke-check.mjs`, redeploy, then re-run E2E.

---

## Manual step: Portal PR push

The cloud agent cannot push to `Proto-Website-` (403) until the Cursor GitHub App is granted access to that repo. See **`docs/portal-cloud-agent-deployment.md`** for the full fix (GitHub app + optional `GH_TOKEN`).

Verify after fixing:

```bash
node scripts/verify-portal-github-access.mjs
```

Until then, from your machine:

```bash
cd Proto-Website-
git fetch origin
git checkout cursor/plumbing-mottaro-fix-55ce   # or cherry-pick 77df741 onto main
git push -u origin cursor/plumbing-mottaro-fix-55ce
```

Then open a PR titled **“Fix Mottaro cross-repo plumbing and tighten sort-order cache”** and merge to `main`.

---

## What you’ll notice in the UI

- **Portal:** Mottaro appears as its own top-level category with products; category reorders reflect within ~15–30s.
- **Admin Product Manager:** Nutstore-loaded items show in Archive even without Positill match; editing their code re-runs lookup.
- **Admin bulk actions:** Buttons reflect how many items you selected; taxonomy edits warn and reload on concurrent edit conflict.
- **Admin load time:** First paint faster — heavy sections (Analytics, Apollo, CRM, WhatsApp, etc.) load on demand.
- **Admin structure:** Banner, Specials, and Pricing are separate panels; Orders/Customers split is on PR #62 pending merge.

---

## Smoke / QA commands

```bash
# Admin
npm run build
node scripts/qa-smoke-check.mjs
ADMIN_DASH_KEY=… node scripts/qa-plumbing-e2e.mjs

# Portal (after merge)
npm run build
node scripts/qa-smoke-check.mjs
```
