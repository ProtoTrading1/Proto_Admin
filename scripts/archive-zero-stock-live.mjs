#!/usr/bin/env node
/**
 * Archive every live website_stock row with exactly zero SOH.
 * Negative stock is kept live. Unknown/null stock is kept.
 *
 * Usage:
 *   node --env-file=.env.vercel scripts/archive-zero-stock-live.mjs
 *   node --env-file=.env.vercel scripts/archive-zero-stock-live.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { isExactlyZeroStock } from '../lib/catalog-stock.mjs';

const APPLY = process.argv.includes('--apply');
const PARALLEL = 40;

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function fetchAll() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('website_stock')
      .select('sku, title, available_stock, stock_qty, keep_live_when_oos')
      .range(from, from + 999);
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

const live = await fetchAll();
const zeros = live.filter(isExactlyZeroStock);
const keepLiveFlag = zeros.filter((r) => r.keep_live_when_oos);

console.log(APPLY ? 'APPLY MODE\n' : 'DRY RUN\n');
console.log(`Live rows: ${live.length}`);
console.log(`Exactly zero SOH: ${zeros.length} (keep_live_when_oos: ${keepLiveFlag.length})`);

if (zeros.length) {
  zeros.slice(0, 15).forEach((r) => console.log(`  ${r.sku}  ${(r.title || '').slice(0, 55)}`));
  if (zeros.length > 15) console.log(`  ... +${zeros.length - 15} more`);
}

if (!APPLY) {
  console.log('\nRe-run with --apply to archive zero-stock rows off the website.');
  process.exit(0);
}

if (!zeros.length) {
  console.log('\nNothing to archive.');
  process.exit(0);
}

let archived = 0;
let errors = 0;
await runParallel(zeros, async (row) => {
  const { error } = await sb.rpc('archive_product', { p_sku: row.sku, p_by: 'zero-stock-purge' });
  if (error) {
    errors += 1;
    console.warn(`  ${row.sku}: ${error.message}`);
  } else {
    archived += 1;
  }
});

const remaining = (await fetchAll()).filter(isExactlyZeroStock);
console.log(`\nArchived: ${archived}, errors: ${errors}`);
console.log(`Zero-stock still live: ${remaining.length}`);
