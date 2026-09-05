#!/usr/bin/env node
/**
 * Align website_stock.barcode with ERP code from description.
 *
 * Two codes per product:
 *   • website_stock.sku        — website catalogue SKU (unique per variant)
 *   • code in (parentheses)    — public.products.sku (ERP / SOH source)
 *
 * The barcode column must store the exact public.products.sku resolved from
 * the description code, not the website SKU.
 *
 * Usage:
 *   node scripts/fix-barcode-from-description.mjs
 *   node scripts/fix-barcode-from-description.mjs --apply
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

export function extractErpCodeFromDescription(text) {
  const m = String(text || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim().replace(/&amp;/g, '&') : '';
}

/** Resolve description code → exact public.products.sku */
export function resolveErpSkuFromDescription(lookupMap, descCode) {
  if (!descCode) return null;
  const direct = findProductBySku(lookupMap, descCode);
  if (direct) return direct.sku;
  if (/[A-Za-z]$/.test(descCode)) {
    const base = findProductBySku(lookupMap, descCode.slice(0, -1));
    if (base) return base.sku;
  }
  return null;
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

async function runParallel(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(fn));
  }
}

async function main() {
  console.log(APPLY ? 'APPLY MODE\n' : 'DRY RUN\n');

  const live = await fetchAll(
    'website_stock',
    'sku, barcode, title, original_description, price, stock_qty, available_stock',
  );
  console.log(`Live rows: ${live.length}`);

  const keys = [...new Set(live.flatMap((r) => {
    const desc = extractErpCodeFromDescription(r.original_description || r.title);
    return [r.sku, r.barcode, desc].filter(Boolean);
  }))];
  const lookupMap = await fetchProductLookupMap(
    sb,
    keys,
    'sku, description, sell_price, stock_qty, available_stock',
  );

  const fixes = [];
  const noDescCode = [];
  const descNotInErp = [];

  for (const row of live) {
    const websiteSku = String(row.sku || '').trim();
    const currentBarcode = String(row.barcode || '').trim();
    const descCode = extractErpCodeFromDescription(row.original_description || row.title);

    if (!descCode) {
      noDescCode.push(websiteSku);
      continue;
    }

    const erpSku = resolveErpSkuFromDescription(lookupMap, descCode);
    if (!erpSku) {
      descNotInErp.push({ sku: websiteSku, descCode, currentBarcode });
      continue;
    }

    const currentErp = currentBarcode ? findProductBySku(lookupMap, currentBarcode) : null;
    if (currentBarcode === erpSku) continue;

    fixes.push({
      sku: websiteSku,
      from: currentBarcode,
      to: erpSku,
      descCode,
      wrongErp: currentErp && currentErp.sku !== erpSku ? currentErp.sku : null,
    });
  }

  console.log(`Barcode fixes needed: ${fixes.length}`);
  console.log(`No description code: ${noDescCode.length}`);
  console.log(`Description code not in ERP (keeping current barcode): ${descNotInErp.length}`);
  if (fixes.length) console.log('Fixes:', fixes);

  if (APPLY && fixes.length) {
    await runParallel(fixes, async ({ sku, to }) => {
      const { error } = await sb.from('website_stock')
        .update({ barcode: to, updated_at: new Date().toISOString() })
        .eq('sku', sku);
      if (error) throw error;
      await sb.rpc('upsert_website_product_from_stock', { p_website_sku: sku });
    });
    console.log(`Updated ${fixes.length} barcode values`);
  }

  const { data: sync, error: syncErr } = await sb.rpc('sync_website_from_products');
  if (syncErr) throw syncErr;
  console.log('\nsync_website_from_products:', sync);

  const refreshed = await fetchAll(
    'website_stock',
    'sku, barcode, title, original_description, price, stock_qty, available_stock',
  );
  const map2 = await fetchProductLookupMap(
    sb,
    refreshed.flatMap((r) => [r.barcode, r.sku, extractErpCodeFromDescription(r.original_description || r.title)].filter(Boolean)),
    'sku, sell_price, stock_qty, available_stock',
  );

  let syncOk = 0;
  let priceMismatch = 0;
  let stockMismatch = 0;
  let noErp = 0;
  let barcodeNotDescErp = 0;
  const issues = [];

  for (const row of refreshed) {
    const descCode = extractErpCodeFromDescription(row.original_description || row.title);
    const erpSku = resolveErpSkuFromDescription(map2, descCode);
    const erp = findProductBySku(map2, row.barcode);

    if (!erp) {
      noErp++;
      issues.push({ sku: row.sku, issue: 'no_erp', barcode: row.barcode, descCode });
      continue;
    }

    if (descCode && erpSku && erp.sku !== erpSku) {
      barcodeNotDescErp++;
      issues.push({ sku: row.sku, issue: 'barcode_not_desc_erp', barcode: row.barcode, descCode, erpSku });
    }

    const livePrice = Number(row.price);
    const erpPrice = Number(erp.sell_price);
    const liveStock = Number(row.available_stock ?? row.stock_qty ?? 0);
    const erpStock = Number(erp.available_stock ?? erp.stock_qty ?? 0);

    if (livePrice !== erpPrice) {
      priceMismatch++;
      issues.push({ sku: row.sku, issue: 'price', livePrice, erpPrice, erp: erp.sku });
    } else if (liveStock !== erpStock) {
      stockMismatch++;
      issues.push({ sku: row.sku, issue: 'stock', liveStock, erpStock, erp: erp.sku });
    } else {
      syncOk++;
    }
  }

  console.log('\n=== SYNC AUDIT ===');
  console.log({
    live: refreshed.length,
    fullySynced: syncOk,
    priceMismatch,
    stockMismatch,
    noErp,
    barcodeNotDescErp,
  });
  if (issues.length) console.log('Issues:', issues.slice(0, 20));

  if (!APPLY) console.log('\nDRY RUN — re-run with --apply');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
