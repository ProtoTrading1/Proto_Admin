---
name: protoportal-admin
description: Expert guide for the standalone Proto Admin Portal (admin.proto.co.za). Use whenever the user mentions admin portal, admin dashboard, Product Manager, Archive, Reorder Grid, Product Loader, Site Content (Featured/Specials/Banner), Analytics, Pricing, or any fix/feature for protoportal-admin — even if they don't say "admin" explicitly. NEVER use the deprecated embedded AdminPage in protoportal-main for admin work.
---

# Proto Admin Portal (standalone)

## Critical: two separate apps

| App | Repository | Production URL |
|-----|------------|----------------|
| **Admin portal (this skill)** | https://github.com/ProtoTrading1/Proto_Admin | https://admin.proto.co.za |
| Main trade portal | https://github.com/ProtoTrading1/ProtoMainSite | https://protoportal-main.vercel.app |

The old embedded admin inside protoportal-main is **deprecated**. Never restore, reference, or deploy it.

## Auth status

**Supabase email/password login** with allowlist (`src/lib/auth.js`). `Root.jsx` → `AdminGate` → `AdminLoginPage` or lazy `AdminPage`. Fulfillment at `/fulfillment` accepts order token links. API: `requireAdminKey`, `requireAdminOrOrderToken`, `requireCronOrAdminKey` in `api/_admin-auth.js`.

## Workflow before changes

1. Work in the **protoportal-admin** repo (local path often `~/Desktop/Repos 🧑🏽‍💻/protoportal-admin`)
2. `git pull` and review current `AdminPage.jsx` — deployed code may differ from memory
3. Commit and push to `protoportal-admin` repo
4. Deploy only the `protoportal-admin` Vercel project — **not** protoportal-main

## Stack

- Vite + React 19 (JSX)
- Supabase (stock + auth env vars via `api/_site-config.js`)
- Vercel serverless `api/` routes
- Package manager: npm

```bash
npm run dev
npm run build
```

## Entry

- `src/main.jsx` → `src/Root.jsx`
- `Root.jsx`: `/fulfillment` → `FulfillmentPage`; else → `AdminGate` (login or `AdminPage`)
- "Portal" button links to protoportal-main.vercel.app

## Admin sections (`AdminPage.jsx` / `GroupedSidebar.jsx` NAV_ITEMS)

| ID | Label |
|----|-------|
| `orders` | Order Requests (workflow tabs, Rand amounts, notify gate) |
| `product-loader` | Product Loader (Nutstore PTR Photos, single/folder upload) |
| `image-replace` | Image Replace (live + archived scope) |
| `catalogue` | Product Manager (live products only) |
| `archive` | Archive (archived products, no category sidebar) |
| `reorder` | Reorder Grid (`ReorderPanel.jsx` + `ReorderGrid.jsx`) |
| `customers` | Customer Management (requests / pre-registration / approved / email analytics) |
| `site-content` | Site Content — Featured + Specials + Banner Editor sub-tabs |
| `analytics` | Analytics |
| `pricing` | Pricing |
| `team` | Team (opens fulfillment team modal, no section) |

Removed (never reintroduce): Apollo (entire tab + engine), WhatsApp/WATI outgoing messaging (opt-in data stays), Cost Tracking,
product approval tab, reorder mode inside Product Manager, recycle-bin
buttons, product-type dropdown.

## Data layer

- `src/lib/products.js` — catalogue CRUD, paging, cache
- `src/lib/taxonomyAdmin.js` + `api/taxonomy.js` — main categories
- `src/lib/fuzzySearch.js` — client search
- `src/components/ReorderGrid.jsx` — drag reorder UI
- `api/` — bulk upload, image transform, orders, analytics, etc.

Taxonomy tree loaded dynamically (`taxonomyTree`), not only static JSON.

## Deploy

- Vercel project: **protoportal-admin**
- Do not deploy protoportal-main to this URL

## Common mistakes to avoid

1. Editing `protoportal-main/src/pages/AdminPage.jsx` — wrong app, fewer features, deprecated
2. Assuming login/session exists
3. Deploying main repo to admin Vercel alias
4. Using an outdated mental model (embedded 6-section admin vs this multi-section app)
5. Reintroducing removed features (Apollo image gen, Cost Tracking, approval tab, recycle bin)
