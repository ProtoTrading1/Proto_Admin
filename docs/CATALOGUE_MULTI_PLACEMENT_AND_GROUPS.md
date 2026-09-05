# Catalogue: Multi-Placement & Product Groups — Design Note

**Status:** Draft for review. No code written yet.
**Scope:** Feature A (multi-location placement) and Feature B (merge products into one card with a variant selector), across `protoportal-admin` and `Proto-Website-`.
**Verified against:** admin `f73c921`+`c925c3c`, website `4a3ae39`, live Stock DB `yiqsvwajozafvalwcero`.

---

## 0. Read this first — corrections to the original spec

The original spec was written without auditing the website repo (stated up front). Having now audited it, **five of its premises are wrong**. The design below follows the corrected facts, not the spec.

| # | Spec claim | Reality | Consequence |
|---|---|---|---|
| 1 | "No grouping/variant concept exists anywhere." | The website has a **complete barcode-based variant grouping system** with a working selector UI — `src/lib/productGroups.js`, `ProductCard.jsx:594-623`. | Feature B is ~half built. We **extend** it rather than building a parallel system. |
| 2 | `parentSku` is "vestigial / dead", repurpose it. | Vestigial in **admin** (`src/lib/products.js:112`), but **load-bearing in the website** — `api/products.js:131` sets `parentSku: row.barcode` as the group key. | Safe to repurpose the admin field. **Do not** touch the website's. |
| 3 | The website queries `website_stock` by category; needs a placements VIEW/RPC. | The website downloads the **entire catalogue** via `/api/products` and filters in the browser. There is no per-category SQL query. | **No VIEW/RPC needed.** Feature A on the website is a few lines. |
| 4 | The website reads Stock with "a lower-privilege key"; RLS is the #1 silent-failure risk. | `api/products.js:180-183` reads Stock with `VITE_STOCK_SUPABASE_KEY`, a **service-role** key, from a serverless function. The browser never touches the Stock project. | **service_role bypasses RLS.** The silent-zero-rows failure cannot occur on the catalogue path. |
| 5 | Grouping "forces the full-scan branch". | Non-primary members can be excluded in **SQL**, preserving `count:'exact'` + `.range()`. | Avoids a ~100× cost increase on the busiest admin screen. |

Two further facts that change acceptance criteria:

- **There is no product detail page.** Products are not URL-addressable; cards open a modal (`ProductCard.jsx:508`). The criterion "links to one product page" is not applicable.
- **The website's test runner is `node:test`** (`package.json:9`), not vitest. Only one test file exists (`tests/registration-approval.test.js`). Admin uses vitest (`npm run test:bi`).

---

## 1. Website read map

**Supabase clients**

| Context | URL / key | Project | Reads `website_stock`? |
|---|---|---|---|
| Browser (`src/lib/supabase.js:3-13`) | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Portal | **No** — auth + `orders` only |
| Serverless (`api/products.js:180-183`, `api/stock.js:28-32`) | `VITE_STOCK_SUPABASE_URL` / `VITE_STOCK_SUPABASE_KEY` (service-role) | Stock | **Yes** |
| Serverless (`api/_site-config.js:5-12`) | `VITE_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Portal | Storage `site-config` |

`grep -rn "VITE_STOCK" src/` returns nothing — the Stock key is never inlined into the client bundle.

**Catalogue flow**

1. `GET /api/products` returns **all** `website_stock` rows (paged 1000 at a time server-side), adapted. `s-maxage=10, swr=60`.
2. Client caches to `localStorage` (`proto_catalog_v10`, 24h TTL), falls back to static `/products.json`.
3. All category filtering, sorting, grouping and paging happen **in the browser** (`src/lib/products.js:396-455`).

**Category matching already supports multiple paths** — `src/lib/products.js:290-311`:

```js
return productPaths(product).some((cp) =>
  cp.length >= resolved.length && resolved.every((seg, i) => cp[i] === seg));
```

This is how Mottaro's dual paths work today (`categoryPaths: [primaryPath, mottaroPath]`). **Feature A rides on this unchanged.**

**Sort order** — `/api/sort-orders` → `sort-orders/orders.json`, keyed by `category/path` string → `skuOrder[]` of **website skus**. Applied only when `sort === 'featured'` on a category page with no search (`src/lib/products.js:435-441`), **before** grouping (`:438` then `:444`).

**Cart / order line** — `src/App.jsx:671-679`: a line is `{ product: <whole adapted object>, qty }`, identity `product.id` (= sku). Submitted payload (`:828-856`) carries `product.id` (sku) and `product.code` (barcode). Grouped cards never enter the cart — `handleAdd` opens the modal and add-to-cart always passes the **selected variant** (`ProductCard.jsx:362`, `:665`).

> **This is why Feature B's hardest requirement is already satisfied**: the order line already carries the specific variant's own sku and barcode.

---

## 2. Database design

Both tables live in the **Stock** project. Migrations numbered from **049** (latest existing is `048`).

```sql
-- 049_product_placements.sql
create table if not exists public.product_placements (
  id           uuid primary key default gen_random_uuid(),
  website_sku  text not null,
  node_path    jsonb not null,
  sort_order   int,
  source       text not null default 'manual',   -- manual | mottaro | primary
  created_at   timestamptz not null default now(),
  unique (website_sku, node_path)
);
create index if not exists product_placements_sku_idx  on public.product_placements (website_sku);
create index if not exists product_placements_path_idx on public.product_placements using gin (node_path);
```

```sql
-- 050_product_groups.sql
create table if not exists public.product_groups (
  id                  uuid primary key default gen_random_uuid(),
  title               text,
  primary_website_sku text not null,
  image_url           text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.product_group_members (
  group_id      uuid not null references public.product_groups(id) on delete cascade,
  website_sku   text not null unique,          -- a sku belongs to at most one group
  variant_label text,
  sort_order    int,
  created_at    timestamptz not null default now(),
  primary key (group_id, website_sku)
);
```

`on delete cascade` on the FK removes the spec's "disband leaves orphans" case for group deletion. It does **not** cover product deletion — see §6.

### RLS and grants

The spec asserted the Stock tables have no RLS. **They do.** Measured:

| Table | RLS | Policies | anon SELECT works? |
|---|---|---|---|
| `website_stock` | on | 1 (`website_stock_public_read`) | yes |
| `main_categories` | on | 1 | yes |
| `archived_products` | on | **0** | **no — zero rows** |
| `products`, `website_products` | on | **0** | **no — zero rows** |

Granting `select` without a policy returns zero rows silently; `archived_products` proves this on live data.

Because the website reads via **service_role**, none of this blocks us. We add policies anyway — they cost nothing and prevent a future anon-side reader from hitting the trap:

```sql
alter table public.product_placements enable row level security;
create policy "product_placements_public_read"
  on public.product_placements for select to anon, authenticated using (true);
grant select on public.product_placements to anon, authenticated;
```

Same for `product_groups` and `product_group_members`.

**No VIEW is required** (correction 3). If one is added later, this is PG17 — create it `with (security_invoker = true)`, otherwise it runs as owner and silently bypasses RLS.

---

## 3. Feature A — multi-placement

**Model.** `website_stock.category` / `subcategory_one..four` remain the canonical **primary** placement. `product_placements` holds **additional** ones. Nothing existing is rewritten.

### Admin

- **New endpoints** (`api/product-placements.js`): list by sku, add, remove. `requireOwner` on writes, matching `api/catalog.js:225` which already uses `requireOwner`.
- **Counts** — `buildCategoryProductCounts` (`api/_taxonomy-utils.js:664`) already runs a second pass for Mottaro. Placements slot into the same loop: load the whole (small) placements table once into a `sku → paths[]` map, then add those node ids alongside the existing `categoryPath` ids.
- **Reads** — `adaptCatalogRow` gains `categoryPaths[]` (primary + placements). Existing single `categoryPath` is unchanged for back-compat.
- **Browse filter** — a category query must also match placement rows. This needs the full-scan branch (`api/catalog.js:252`), which already triggers on search and deep paths.
- **Reorder grid** — currently groups on the single `product.categoryPath` (`ReorderGrid.jsx:11-40`) and keys cards on bare `product.id` (`:612`). A multi-placed product must expand to one entry per placement with composite `sku@pathKey` keys, or two placements of the same sku collide in React.
- **Node delete** must prune matching `product_placements` rows, parallel to `clearProductsForDeletedNode`. Renames need nothing — placements key on stable node ids.

### Website

Add placement paths into `categoryPaths[]` in `api/products.js` (alongside the existing Mottaro enrichment at `:170`). **The client matcher needs no change.**

Cost: one extra query per `/api/products` call to load placements. The table is small; fetch it whole and map by sku.

---

## 4. Feature B — merge into one card (extending the existing system)

**Decision: extend `groupProductsByBarcode`, do not build a parallel system.**

### The extension point

`variantGroupKey` (`src/lib/productGroups.js:2-5`) currently returns the barcode. Generalise it to prefer an admin group:

```js
export function variantGroupKey(product) {
  const adminGroup = String(product?.groupId || '').trim();
  if (adminGroup) return `g:${adminGroup}`;
  const barcode = String(product?.barcode || product?.code || '').trim();
  return barcode ? `b:${barcode}` : null;
}
```

Everything downstream — grouping, `expandBarcodeSiblings`, the selector UI, cart aggregation, stock roll-up — works unchanged.

**Precedence that falls out of this, and is correct:**
- Admin group beats shared barcode.
- Two products in the same admin group with **different** barcodes now group together — Feature B's actual goal.
- Two products sharing a barcode but in **different** admin groups split apart.

**Two required fixes to the synthetic card** (`productGroups.js:66-79`):
1. `code`/`barcode` are currently set to the group key. For an admin group that would put `g:<uuid>` where a barcode belongs. Set them from the **primary member** instead.
2. `deriveGroupTitle` derives a common prefix. For an admin group, prefer `product_groups.title`, then the primary's title, then the prefix heuristic.

Single-member groups already fall through to a normal card (`:57-59`) — the spec's edge case is handled for free.

### Sort order — no rewrite needed on the website

The spec calls for rewriting member skus → primary sku inside `skuOrder[]`. **Not needed for the website:** ordering is applied to the flat list *before* grouping, and grouping preserves first-appearance order, so the card lands at its first member's sorted position. This already works for barcode groups today.

It *may* still matter for the admin reorder grid, which groups differently. Treat as an admin-only concern.

### Admin

- Replace the dead `parentSku: null` (`src/lib/products.js:112`, `api/products.js:37`) with `groupId` / `groupPrimarySku` / `variantLabel`.
- **Member suppression in SQL, not by collapsing** (correction 5):

```js
q = q.not('sku', 'in', `(${nonPrimaryMemberSkus.join(',')})`)
```

Every surviving row is ungrouped or a primary, so `count:'exact'` + `.range()` stay exact and the fast path survives. Group data is attached to the ≤50 primaries on the current page.

Measured impact of the alternative: 5,453 live rows would be fetched (6 round-trips) and passed through `enrichRowsWithProductStock` on **every** Product Manager page load, versus 50 today.

**Documented limit:** `.in()` travels in the query string. Safe for hundreds of non-primary members; the plan must include a row-count threshold above which it falls back to full-scan.

- **Search ordering** — expand over all members → map any member hit to its group's primary → dedupe by group id. Note `api/catalog.js:252` already forces full-scan whenever a search term is present, so this costs nothing new.
- **Stock/status filters** — "card shows if **any** member qualifies", applied post-collapse. `onlyInStock` and `stockFilter=negative` already full-scan, so again no new slow path. `toOrderOnly` is currently pushed into SQL (`catalog.js:154`, `:57`) and must **not** be when grouping is active, or members are filtered out before the roll-up.
- **Price** — range across members computed on `formatWebsitePrice(row.price)` (VAT-inclusive, `src/lib/pricing.js`), never `sell_price` (ex-VAT). Aggregate is never written back.

---

## 5. Interaction between A and B

Placements attach to the **primary member's sku**; the group inherits them. A grouped card appears once per assigned category (dedupe by group id). Members never surface as separate cards anywhere. Featured/specials operate on the primary sku.

---

## 6. Lifecycle hazards (verified, not assumed)

**`api/delete-product.js:24-28` deletes from exactly three tables** — `website_stock`, `archived_products`, `staged_product_previews`. It will orphan `product_group_members` and `product_placements` rows. Because `product_group_members.website_sku` is UNIQUE, an orphan then **blocks re-creating that sku**. Must cascade.

**Archive/unarchive** (`api/stock-actions.js:110-123`) moves a row between tables. Aggregation reads `website_stock` only (`_stock-client.js:58-107`), so archiving a non-primary member silently strands it. On primary archive/delete: auto-promote a new primary, or deactivate the group.

**Featured / specials remap.** `featured-products.json` stores `sku[]`; `specials.json` keys on `item.productId`. If a referenced sku becomes a suppressed non-primary member, the slot points at a card that no longer renders. On merge, remap to the group's primary sku — or block merging a featured/special sku.

**Exports must not collapse.** `exportLiveProducts.js` pulls `/api/catalog`; if that collapses, exports silently lose every non-primary variant. Add `collapse=false`.

**Apollo/BI, analytics, ERP sync stay per-variant.** No grouping pushed into them. Apollo is under governance — not touched.

---

## 7. Kill switches

Two `site-config` flags, following `api/_site-config.js`:

- `features/multi-placement`
- `features/catalog-grouping`

Both gate the admin UI **and** the read paths in admin and website. Empty tables are necessary but not sufficient for rollback — a bad collapse with populated tables must be disableable without deleting data.

---

## 8. Deploy order

Per feature: **migration → admin API → admin UI → website read → website render.** Migrations are forward-only and idempotent (`create table if not exists`). Each PR states its order.

Rollback: flip the kill switch. Tables can stay populated.

---

## 9. Honest risk register

| Risk | Assessment |
|---|---|
| `.in()` suppression outgrows the query string | Real but bounded. Needs a measured threshold + full-scan fallback. Not yet measured — no groups exist. |
| Extending `variantGroupKey` changes behaviour for existing **barcode** groups | Low but non-zero. Any product given an admin group leaves its barcode group. Needs a test pinning current barcode-grouping output. |
| Website has **one** test file and no catalogue tests | The riskiest area has the least coverage. New `node:test` tests must be written from scratch, and `src/lib/products.js` pulls in JSON imports that make pure-Node testing awkward. |
| Mottaro is the cited precedent but has **2 rows** | It is a sketch, not a proven pattern. Following its shape is fine; treating it as validated is not. |
| `VITE_STOCK_SUPABASE_KEY` is a service-role key behind a `VITE_` prefix | Server-only today in both repos (verified). One `import.meta.env` reference in client code would ship full DB access to browsers. Worth renaming, out of scope here. |
| `orders.total_ex_vat` stores a VAT-**inclusive** total (`src/lib/orders.js:28`) | Pre-existing misnaming, unrelated to this work, but will confuse anyone computing price ranges. Do not "fix" it here. |

**What I have not verified:** actual `.in()` query-string limits against PostgREST at Proto's scale; whether any Brevo/Intercom/ERP consumer reads `parentSku` from the website payload; performance of the placements join at 5,453 rows under real load.

---

## 10. Test strategy

**Admin (vitest, `npm run test:bi`)** — placement resolution and counts; SQL suppression correctness; search-by-variant-barcode → group card; group-aware stock filters; aggregate stock and VAT-inclusive price range; delete/archive cascade; featured/specials remap; export `collapse=false` returns raw rows.

**Website (`node:test`)** — `variantGroupKey` precedence (admin group over barcode); grouped card carries the primary's barcode, not the group key; variant selection yields that variant's own sku/barcode; multi-path category matching.

**Back-compat guard (both repos, mandatory):** with the new tables empty **and** kill switches off, catalog output, category counts and exports are byte-for-byte identical to today. This is the single most valuable test in the suite.
