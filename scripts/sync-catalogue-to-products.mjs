#!/usr/bin/env node
/**
 * Ensure every website catalogue ERP key (barcode) exists in public.products
 * so SOH sync works for live + archived items.
 *
 * Sources: website_stock, archived_products, website_products
 * Only INSERTS missing products rows — never overwrites existing ERP data.
 *
 * Usage: VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node scripts/sync-catalogue-to-products.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { findProductBySku, fetchProductLookupMap } from '../api/_sku-match.js';
import { catalogueRowToProductPayload, groupCatalogueRowsByErpKey } from '../api/_ensure-product.js';

const BATCH = 100;
const url = process.env.STOCK_SUPABASE_URL || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY || process.env.VITE_STOCK_SUPABASE_KEY;

if (!url || !key) {
  console.error('Missing stock Supabase env vars');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(table, select) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function main() {
  const [live, archived, bridge] = await Promise.all([
    fetchAll('website_stock', 'sku, barcode, title, original_description, price, stock_qty, available_stock, units_of_issue'),
    fetchAll('archived_products', 'sku, barcode, title, original_description, price, stock_qty, available_stock, units_of_issue'),
    fetchAll('website_products', 'website_sku, barcode, product_sku, title, description'),
  ]);

  const liveSkus = new Set(live.map((r) => r.sku));
  const bridgeAsCatalogue = bridge.map((r) => ({
    sku: r.website_sku,
    barcode: r.product_sku || r.barcode,
    title: r.title,
    original_description: r.description,
    price: 0,
    stock_qty: 0,
    available_stock: 0,
    units_of_issue: 'EACH',
  }));

  const grouped = groupCatalogueRowsByErpKey(
    [...live, ...archived, ...bridgeAsCatalogue],
    { preferLiveSkus: liveSkus },
  );

  const keys = [...grouped.keys()];
  const lookup = await fetchProductLookupMap(sb, keys, 'sku');
  const missing = keys.filter((key) => !findProductBySku(lookup, key));

  console.log(`Catalogue ERP keys: ${keys.length}`);
  console.log(`Already in products: ${keys.length - missing.length}`);
  console.log(`To insert: ${missing.length}`);

  let inserted = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH).map((key) => catalogueRowToProductPayload(grouped.get(key))).filter(Boolean);
    if (!batch.length) continue;
    const { error } = await sb.from('products').insert(batch);
    if (error) throw error;
    inserted += batch.length;
    console.log(`Inserted ${inserted}/${missing.length}`);
  }

  const { data: syncResult, error: syncErr } = await sb.rpc('sync_website_from_products');
  if (syncErr) console.warn('sync_website_from_products:', syncErr.message);
  else console.log('sync:', syncResult);

  // Re-verify
  const lookupAfter = await fetchProductLookupMap(sb, keys, 'sku');
  const stillMissing = keys.filter((key) => !findProductBySku(lookupAfter, key));
  console.log(`Done. Still missing: ${stillMissing.length}`);
  if (stillMissing.length) console.log('Samples:', stillMissing.slice(0, 10));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
