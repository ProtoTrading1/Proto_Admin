#!/usr/bin/env node
/**
 * Permanently delete archived catalogue rows that cannot sync to public.products,
 * and/or all zero-stock archived rows (nothing with 0 SOH left in Archive).
 *
 * Usage:
 *   node scripts/purge-unsynced-archived.mjs
 *   node scripts/purge-unsynced-archived.mjs --apply
 *   node scripts/purge-unsynced-archived.mjs --apply --zero-only
 */

import { createClient } from '@supabase/supabase-js';
import { findProductBySku, fetchProductLookupMap } from '../api/_sku-match.js';
import { extractErpCodeFromDescription, resolveErpSkuFromDescription } from './fix-barcode-from-description.mjs';

const APPLY = process.argv.includes('--apply');
const ZERO_ONLY = process.argv.includes('--zero-only');
const KEEP_ARCHIVED_BY = new Set(['new-products', 'recycle-bin']);
const BATCH = 100;
const PARALLEL = 40;

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

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

function resolveErp(lookupMap, row) {
  const descCode = extractErpCodeFromDescription(row.original_description || row.title);
  const erpFromDesc = resolveErpSkuFromDescription(lookupMap, descCode);
  const barcode = String(row.barcode || '').trim();
  const byBarcode = barcode ? findProductBySku(lookupMap, barcode) : null;
  const bySku = findProductBySku(lookupMap, row.sku);
  return erpFromDesc
    ? findProductBySku(lookupMap, erpFromDesc)
    : byBarcode || bySku;
}

async function runParallel(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(fn));
  }
}

function effectiveStock(row, erp) {
  const n = Number(erp?.available_stock ?? erp?.stock_qty ?? row.available_stock ?? row.stock_qty ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function permanentlyDelete(sku) {
  await sb.from('website_stock').delete().eq('sku', sku);
  const { error: archErr } = await sb.from('archived_products').delete().eq('sku', sku);
  if (archErr) throw archErr;
  await sb.from('website_products').delete().eq('website_sku', sku);
}

async function main() {
  console.log(APPLY ? 'APPLY MODE\n' : 'DRY RUN\n');

  const archived = await fetchAll(
    'archived_products',
    'sku, barcode, title, original_description, archived_by, stock_qty, available_stock',
  );
  console.log(`Archived rows: ${archived.length}${ZERO_ONLY ? ' (zero-only purge)' : ''}`);

  const keys = [...new Set(archived.flatMap((r) => {
    const desc = extractErpCodeFromDescription(r.original_description || r.title);
    return [r.sku, r.barcode, desc].filter(Boolean);
  }))];
  const lookupMap = await fetchProductLookupMap(
    sb,
    keys,
    'sku, sell_price, stock_qty, available_stock',
  );

  const toDelete = [];
  const toKeep = [];

  for (const row of archived) {
    if (KEEP_ARCHIVED_BY.has(row.archived_by)) {
      toKeep.push(row.sku);
      continue;
    }

    const erp = resolveErp(lookupMap, row);
    const stock = effectiveStock(row, erp);

    if (ZERO_ONLY) {
      if (stock === 0) toDelete.push({ sku: row.sku, reason: 'zero_stock' });
      else toKeep.push(row.sku);
      continue;
    }

    if (!erp) toDelete.push({ sku: row.sku, reason: 'no_erp' });
    else toKeep.push(row.sku);
  }

  console.log(`Can sync / non-zero (keep): ${toKeep.length}`);
  console.log(`Permanent delete: ${toDelete.length}${ZERO_ONLY ? ' (zero stock only)' : ' (no ERP)'}`);

  if (APPLY && toDelete.length) {
    let deleted = 0;
    let errors = 0;
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const chunk = toDelete.slice(i, i + BATCH);
      await runParallel(chunk, async ({ sku }) => {
        try {
          await permanentlyDelete(sku);
          deleted++;
        } catch (err) {
          errors++;
          console.warn(`delete ${sku}:`, err.message);
        }
      });
      console.log(`Progress: ${Math.min(i + BATCH, toDelete.length)}/${toDelete.length}`);
    }
    console.log(`\nDeleted: ${deleted}, errors: ${errors}`);
  }

  const remainingArchived = APPLY ? await fetchAll('archived_products', 'sku') : archived.filter((r) => toKeep.includes(r.sku));
  const live = await fetchAll('website_stock', 'sku');
  console.log('\n=== FINAL ===');
  console.log({
    live: live.length,
    archived: remainingArchived.length,
    purged: toDelete.length,
  });

  if (!APPLY) console.log('\nDRY RUN — re-run with --apply');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
