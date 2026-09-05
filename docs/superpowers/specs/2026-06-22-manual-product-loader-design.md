# Manual Product Loader — Design Spec
**Date:** 2026-06-22  
**Status:** Approved — implementing Phase 1 MVP

## Purpose

Admin tool for publishing products directly to `website_stock` from Positill (STMAST SQL Server). Bypasses the Apollo/Approval staging flow. Admin-only, confirmation-gated.

## Architecture

### New files
| File | Purpose |
|---|---|
| `api/_sql-provider.js` | Abstraction over `_sql-stmast.js` — exposes `getProductByCode()`, stubs for Phase 2 |
| `api/product-loader-lookup.js` | GET `?code=`: SQL fetch + Supabase check + image search + warnings |
| `api/product-loader-publish.js` | POST: write to `website_stock` + audit row |
| `migrations/029_product_publish_audit.sql` | Audit table |
| `src/components/ProductLoaderPanel.jsx` | UI |

### Reused unchanged
`upload-product-image` · `transform-product-image` · `analyze-product-image` · `_sql-stmast.js` · `_r2-storage.js`

## Data Flow

```
Admin enters code
  → GET /api/product-loader-lookup?code=...
      SQLProvider.getProductByCode() → _sql-stmast.js (bridge / direct mssql)
      Supabase website_stock check
      Collect existingImages from image_url_one–four
      Compute warnings: price_zero | low_stock | image_exists
      Return: { sqlRow, websiteRow, existingImages, sqlAvailable, warnings }

Admin uploads image (if needed)
  → POST /api/upload-product-image   (plain upload)
  → POST /api/transform-product-image   (BG removal, returns { url, base64 })
  → POST /api/upload-product-image   (uploads transformed base64 → permanent URL)

Admin reviews category (always shown)
  → POST /api/analyze-product-image   (optional Gemini suggestion)
  → Admin confirms/overrides via dropdowns

Admin clicks Publish
  → POST /api/product-loader-publish
      Safety: reject if imageField filled and overwriteImage: false
      existing SKU → UPDATE website_stock
      new SKU → INSERT into website_stock
      INSERT product_publish_audit (old_values, new_values, publishMode, imageSlot, imageSource)
      Return { ok, action, sku }
```

## API Spec

### GET `/api/product-loader-lookup?code=TBAG91`
Response:
```json
{
  "sqlRow": { "code": "TBAG91", "title": "Tote Bag 91", "price": 12.50, "onhand": 48, "booked": 3, "available": 45, "dept": "BAG" },
  "websiteRow": { "sku": "TBAG91", "title": "...", "image_url_one": "...", "category": "Fashion", ... },
  "existingImages": ["https://..."],
  "sqlAvailable": true,
  "sqlSetupMessage": null,
  "warnings": ["price_zero", "low_stock", "image_exists"]
}
```
- `sqlRow` — null when STMAST bridge offline (UI still works for known SKUs)
- `warnings` — string codes; UI renders yellow banners and confirmation checkboxes

### POST `/api/product-loader-publish`
Body:
```json
{
  "code": "TBAG91", "title": "...", "price": 12.50,
  "imageUrl": "https://...", "imageSlot": 1, "imageSource": "upload",
  "overwriteImage": true,
  "category": "Fashion & Accessories", "subcategoryOne": "Bags", "subcategoryTwo": null,
  "description": "...", "categoryConfidence": 0.85,
  "publishMode": "direct", "publishedBy": "admin@proto.co.za"
}
```
- 409 if `imageField` is filled and `overwriteImage: false`
- Returns `{ ok: true, action: "create"|"update", sku }`

## Audit Table

```sql
product_publish_audit (
  id, sku, action, source, publish_mode, image_slot, image_source,
  category_confidence, old_values jsonb, new_values jsonb,
  published_by, published_at
)
```
Service-role only. `old_values` captures the pre-change row; `new_values` captures written fields only.

## UI Flow (ProductLoaderPanel)

1. Enter code → Look up
2. Product card: title, price, stock, existing website status
3. Warnings: price zero / low stock (yellow banners)
4. Image section: existing thumbnails (click to select) + upload area + slot selector
5. Upload options: "Upload as-is" | "Remove background + Upload"
6. Category section: dropdowns (category, sub1, sub2) + "Suggest from image" button
7. Confirmations: price_zero checkbox + overwrite checkbox (only when relevant)
8. Publish button → success state

## Safety Gates

| Condition | Gate |
|---|---|
| `price_zero` | Yellow warning + required checkbox before publish |
| `low_stock` | Yellow warning only (not blocked) |
| `image_exists` on target slot | Red warning + required checkbox if replacing |
| No `overwriteImage` from server | 409 → client shows error, no data written |

## Extensibility

- `publishMode: 'direct'` field reserved for future `'send_to_staging'` mode
- `imageSource` field reserved for `'r2'` source (Phase 2 R2 image search)
- `_sql-provider.js` stubs: `searchProducts()`, `getSupplierProducts()` for Phase 2
