#!/usr/bin/env node
/**
 * Catalogue cleanup after Proto Product Report import.
 *
 * 1. Ensure website_stock.barcode is set (from description parentheses when empty)
 * 2. Run sync_website_from_products (full SOH + price sync from public.products)
 * 3. Archive live rows that cannot sync to ERP
 * 4. Archive live rows with exactly zero stock (negative stock is kept)
 *
 * Usage:
 *   node scripts/cleanup-zero-unsynced.mjs
 *   node scripts/cleanup-zero-unsynced.mjs --apply
 */

import { createClient } from '@supabase/supabase-js';
import { findProductBySku, fetchProductLookupMap } from '../api/_sku-match.js';

const APPLY = process.argv.includes('--apply');
const PARALLEL = 40;

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

export function extractBarcodeFromDescription(text) {
  const m = String(text || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim().replace(/&amp;/g, '&') : '';
}

async function fetchAll(table, select) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data?.length || data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

function effectiveStock(row) {
  return Number(row.available_stock ?? row.stock_qty ?? 0);
}

function resolveErp(lookupMap, row) {
  const barcode = String(row.barcode || '').trim() || extractBarcodeFromDescription(row.original_description || row.title);
  return findProductBySku(lookupMap, barcode)
    || findProductBySku(lookupMap, row.sku)
    || (barcode && /[A-Za-z]$/.test(barcode) ? findProductBySku(lookupMap, barcode.slice(0, -1)) : null);
}

async function runParallel(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(fn));
  }
}

async function main() {
  console.log(APPLY ? 'APPLY MODE\n' : 'DRY RUN\n');

  let live = await fetchAll(
    'website_stock',
    'sku, barcode, title, original_description, price, stock_qty, available_stock',
  );
  console.log(`Live catalogue: ${live.length} SKUs`);

  const skuCounts = new Map();
  for (const row of live) {
    const k = String(row.sku || '').trim().toUpperCase();
    skuCounts.set(k, (skuCounts.get(k) || 0) + 1);
  }
  const dupSkus = [...skuCounts.entries()].filter(([, c]) => c > 1);
  if (dupSkus.length) {
    console.error('Duplicate website SKUs found:', dupSkus.slice(0, 10));
    process.exit(1);
  }
  console.log('Duplicate check: OK (0 duplicate website SKUs)\n');

  const barcodeFixes = [];
  for (const row of live) {
    const fromDesc = extractBarcodeFromDescription(row.original_description || row.title);
    if (!fromDesc) continue;
    const current = String(row.barcode || '').trim();
    if (!current) {
      barcodeFixes.push({ sku: row.sku, barcode: fromDesc });
    }
  }
  console.log(`Barcode backfill from description: ${barcodeFixes.length}`);
  if (APPLY && barcodeFixes.length) {
    await runParallel(barcodeFixes, async ({ sku, barcode }) => {
      await sb.from('website_stock').update({ barcode, updated_at: new Date().toISOString() }).eq('sku', sku);
    });
    live = await fetchAll(
      'website_stock',
      'sku, barcode, title, original_description, price, stock_qty, available_stock',
    );
  }

  const { data: syncBefore, error: syncErr } = await sb.rpc('sync_website_from_products');
  if (syncErr) throw syncErr;
  console.log('sync_website_from_products:', syncBefore);

  live = await fetchAll(
    'website_stock',
    'sku, barcode, title, original_description, price, stock_qty, available_stock',
  );

  const erpKeys = [...new Set(live.flatMap((r) => {
    const bc = String(r.barcode || '').trim() || extractBarcodeFromDescription(r.original_description || r.title);
    return [bc, r.sku].filter(Boolean);
  }))];
  const lookupMap = await fetchProductLookupMap(
    sb,
    erpKeys,
    'sku, sell_price, stock_qty, available_stock',
  );

  const toArchive = [];
  const stats = {
    keepPositive: 0,
    keepNegative: 0,
    archiveZero: 0,
    archiveNoErp: 0,
    archiveNoPrice: 0,
    priceMismatch: 0,
  };

  for (const row of live) {
    const stock = effectiveStock(row);
    const erp = resolveErp(lookupMap, row);

    if (stock < 0) {
      stats.keepNegative++;
      if (!erp) stats.archiveNoErp++;
      continue;
    }

    if (!erp) {
      stats.archiveNoErp++;
      toArchive.push({ sku: row.sku, reason: 'no_erp' });
      continue;
    }

    const erpPrice = Number(erp.sell_price);
    const livePrice = Number(row.price);
    if (!Number.isFinite(erpPrice) || erpPrice <= 0) {
      if (stock === 0) {
        stats.archiveZero++;
        toArchive.push({ sku: row.sku, reason: 'zero_no_price' });
      } else {
        stats.archiveNoPrice++;
        toArchive.push({ sku: row.sku, reason: 'no_price' });
      }
      continue;
    }

    if (stock === 0) {
      stats.archiveZero++;
      toArchive.push({ sku: row.sku, reason: 'zero_stock' });
      continue;
    }

    if (livePrice !== erpPrice) stats.priceMismatch++;
    stats.keepPositive++;
  }

  const uniqueArchive = [...new Map(toArchive.map((x) => [x.sku, x])).values()];
  console.log('\nPlanned archive:', uniqueArchive.length);
  console.log('Stats:', stats);
  console.log('Would remain live:', live.length - uniqueArchive.length);

  if (APPLY && uniqueArchive.length) {
    let archived = 0;
    let errors = 0;
    await runParallel(uniqueArchive, async ({ sku, reason }) => {
      const { error } = await sb.rpc('archive_product', { p_sku: sku, p_by: `cleanup-${reason}` });
      if (error) {
        errors++;
        console.warn(`archive ${sku}:`, error.message);
      } else {
        archived++;
      }
    });
    console.log(`\nArchived: ${archived}, errors: ${errors}`);
  }

  const { data: syncAfter, error: syncAfterErr } = await sb.rpc('sync_website_from_products');
  if (syncAfterErr) console.warn('post-cleanup sync:', syncAfterErr.message);
  else console.log('post-cleanup sync:', syncAfter);

  const remaining = await fetchAll('website_stock', 'sku, stock_qty, available_stock, price, barcode');
  const remainKeys = [...new Set(remaining.flatMap((r) => [r.barcode, r.sku].filter(Boolean)))];
  const remainMap = await fetchProductLookupMap(sb, remainKeys, 'sku, sell_price, stock_qty, available_stock');

  let finalPos = 0;
  let finalNeg = 0;
  let finalNoErp = 0;
  let finalPriceBad = 0;
  for (const row of remaining) {
    const stock = effectiveStock(row);
    const erp = resolveErp(remainMap, row);
    if (stock < 0) finalNeg++;
    else if (stock > 0) finalPos++;
    if (!erp) finalNoErp++;
    else if (Number(row.price) !== Number(erp.sell_price)) finalPriceBad++;
  }

  console.log('\n=== FINAL ===');
  console.log({
    live: remaining.length,
    positiveStock: finalPos,
    negativeStock: finalNeg,
    noErpRemaining: finalNoErp,
    priceSyncIssues: finalPriceBad,
    duplicateSkus: 0,
  });

  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to commit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
