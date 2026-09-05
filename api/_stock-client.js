import { createClient } from '@supabase/supabase-js';
import { findProductBySku, fetchProductLookupMap } from './_sku-match.js';

/**
 * Stock Supabase client for serverless API routes.
 * Uses STOCK_SUPABASE_POOLER_URL when set — this must be the HTTPS REST URL
 * (https://[ref].supabase.co), not a postgres:// pooler connection string.
 * PostgREST pools DB connections server-side; this env separates server routes
 * from the VITE_* client bundle URL.
 */
export function getStockClient() {
  const url = process.env.STOCK_SUPABASE_POOLER_URL
    || process.env.STOCK_SUPABASE_URL
    || process.env.VITE_STOCK_SUPABASE_URL;
  const key = process.env.STOCK_SUPABASE_KEY
    || process.env.VITE_STOCK_SUPABASE_KEY;
  if (!url || !key) throw new Error('Missing stock Supabase env vars');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function stockKeyForRow(row, linkByWebsiteSku) {
  return linkByWebsiteSku.get(row.sku) || row.barcode || row.sku || '';
}

/** Resolve ERP product SKU per website row (website_products, else barcode). */
export async function resolveProductSkusForRows(supabase, rows) {
  const websiteSkus = [...new Set(rows.map((r) => r.sku).filter(Boolean))];
  const linkByWebsiteSku = new Map();
  if (websiteSkus.length) {
    for (let i = 0; i < websiteSkus.length; i += 500) {
      const chunk = websiteSkus.slice(i, i + 500);
      const { data, error } = await supabase
        .from('website_products')
        .select('website_sku, product_sku, barcode')
        .in('website_sku', chunk);
      if (error) {
        if (/website_products/i.test(String(error.message || ''))) break;
        throw error;
      }
      for (const l of data || []) {
        const sku = l.product_sku || l.barcode || null;
        if (sku) linkByWebsiteSku.set(l.website_sku, sku);
      }
    }
  }

  const rawKeys = rows.map((r) => stockKeyForRow(r, linkByWebsiteSku));
  const lookupMap = await fetchProductLookupMap(supabase, rawKeys, 'sku');
  return rows.map((r, i) => {
    const product = findProductBySku(lookupMap, rawKeys[i]);
    return product?.sku || rawKeys[i] || null;
  });
}

/** Attach live SOH + price from public.products (fuzzy SKU match + website_products). */
export async function enrichRowsWithProductStock(supabase, rows, { includePrice = false } = {}) {
  if (!rows.length) return rows;

  const websiteSkus = [...new Set(rows.map((r) => r.sku).filter(Boolean))];
  const linkByWebsiteSku = new Map();
  if (websiteSkus.length) {
    for (let i = 0; i < websiteSkus.length; i += 500) {
      const chunk = websiteSkus.slice(i, i + 500);
      const { data, error } = await supabase
        .from('website_products')
        .select('website_sku, product_sku, barcode')
        .in('website_sku', chunk);
      if (error) {
        if (/website_products/i.test(String(error.message || ''))) break;
        throw error;
      }
      for (const l of data || []) {
        const sku = l.product_sku || l.barcode || null;
        if (sku) linkByWebsiteSku.set(l.website_sku, sku);
      }
    }
  }

  const rawKeys = rows.map((r) => stockKeyForRow(r, linkByWebsiteSku));
  const cols = includePrice ? 'sku, stock_qty, available_stock, sell_price' : 'sku, stock_qty, available_stock';
  const lookupMap = await fetchProductLookupMap(supabase, rawKeys, cols);

  return rows.map((r, i) => {
    const product = findProductBySku(lookupMap, rawKeys[i]);
    if (!product) {
      // Preserve whatever the catalogue row already has, including null/undefined.
      // Coercing missing ERP stock to 0 makes zero-stock filters (e.g. archive)
      // silently hide rows that never had an ERP source of truth — e.g. Nutstore
      // placeholders waiting to be matched.
      return {
        ...r,
        stockLinked: false,
      };
    }
    return {
      ...r,
      stock_qty: product.stock_qty ?? 0,
      available_stock: product.available_stock ?? product.stock_qty ?? 0,
      stockLinked: true,
      ...(includePrice ? { sell_price: product.sell_price } : {}),
      ...(includePrice && product.sell_price != null && !Number(r.price)
        ? { price: Number(product.sell_price) || 0 }
        : {}),
    };
  });
}
