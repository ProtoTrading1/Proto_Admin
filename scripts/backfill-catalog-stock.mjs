#!/usr/bin/env node
/**
 * Backfill stock_qty, available_stock, and price on website_stock + archived_products
 * from public.products (handles leading-zero SKU mismatches).
 *
 * Usage: VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node scripts/backfill-catalog-stock.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { findProductBySku, fetchProductLookupMap } from '../api/_sku-match.js';

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

function patchFromProduct(row, product) {
  if (!product) return null;
  const patch = {
    stock_qty: product.stock_qty,
    available_stock: product.available_stock,
    updated_at: new Date().toISOString(),
  };
  const price = Number(product.sell_price);
  if (Number.isFinite(price) && price > 0 && (!row.price || Number(row.price) <= 0)) {
    patch.price = price;
  }
  return patch;
}

async function backfillTable(table, rows) {
  const keys = rows.map((r) => r.barcode || r.sku).filter(Boolean);
  const lookupMap = await fetchProductLookupMap(sb, keys, 'sku, sell_price, stock_qty, available_stock');
  let updated = 0;
  let zeroed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (row) => {
      const product = findProductBySku(lookupMap, row.barcode || row.sku);
      const patch = product
        ? patchFromProduct(row, product)
        : {
            stock_qty: 0,
            available_stock: 0,
            updated_at: new Date().toISOString(),
          };
      if (!product) zeroed++;
      const { error } = await sb.from(table).update(patch).eq('sku', row.sku);
      if (error) throw error;
      updated++;
    }));
    console.log(`${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  return { updated, zeroed };
}

async function main() {
  const [website, archived] = await Promise.all([
    fetchAll('website_stock', 'sku, barcode, price, stock_qty, available_stock'),
    fetchAll('archived_products', 'sku, barcode, price, stock_qty, available_stock'),
  ]);

  console.log(`website_stock: ${website.length}, archived_products: ${archived.length}`);

  const ws = await backfillTable('website_stock', website);
  console.log('website_stock done', ws);

  const ar = await backfillTable('archived_products', archived);
  console.log('archived_products done', ar);

  const { data: syncResult, error } = await sb.rpc('sync_website_from_products');
  if (error) console.warn('sync:', error.message);
  else console.log('sync:', syncResult);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
