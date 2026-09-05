#!/usr/bin/env node
/**
 * Import full ERP product master from data/111.numbers into public.products.
 *
 * Columns: sku, description, sell_price, stock_qty, available_stock, units_of_issue
 * Upserts on products.sku — website catalogue links via website_products / barcode.
 *
 * Usage:
 *   VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node scripts/import-111-products.mjs
 *   node scripts/import-111-products.mjs --dry-run
 *   node scripts/import-111-products.mjs --file /path/to/111.numbers
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(__dirname, '../data/111.numbers');
const BATCH = 200;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find((a) => a.startsWith('--file='))?.slice(7)
  || (args.includes('--file') ? args[args.indexOf('--file') + 1] : null);
const numbersPath = fileArg || DEFAULT_FILE;

const url = process.env.STOCK_SUPABASE_URL
  || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY
  || process.env.VITE_STOCK_SUPABASE_KEY;

if (!url || !key) {
  console.error('Missing STOCK_SUPABASE_URL / STOCK_SUPABASE_KEY (or VITE_* variants)');
  process.exit(1);
}

if (!existsSync(numbersPath)) {
  console.error(`Missing file: ${numbersPath}`);
  process.exit(1);
}

/** Normalize Numbers/Excel SKU artifacts (17.0 → 17) to match products.sku. */
export function normalizeSku(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') {
    if (Number.isInteger(raw)) return String(raw);
    const s = String(raw);
    if (/^\d+\.0$/.test(s)) return s.slice(0, -2);
    return s;
  }
  const s = String(raw).trim();
  if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
  return s;
}

function toNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function loadRowsFromNumbers(path) {
  const py = `
from numbers_parser import Document
import json, sys
doc = Document(sys.argv[1])
t = doc.sheets[0].tables[0]
rows = []
for r in range(1, t.num_rows):
    sku = t.cell(r, 0).value
    if sku is None or str(sku).strip() == '':
        continue
    rows.append({
        'sku': sku,
        'description': t.cell(r, 1).value,
        'sell_price': t.cell(r, 2).value,
        'stock_qty': t.cell(r, 3).value,
        'available_stock': t.cell(r, 4).value,
        'units_of_issue': t.cell(r, 5).value,
    })
print(json.dumps(rows))
`;
  const res = spawnSync('python3', ['-c', py, path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    throw new Error('Failed to parse Numbers file — install: pip install numbers-parser');
  }
  return JSON.parse(res.stdout);
}

function rowToProduct(raw) {
  const sku = normalizeSku(raw.sku);
  if (!sku) return null;
  const now = new Date().toISOString();
  return {
    sku,
    description: String(raw.description ?? '').trim(),
    sell_price: toNumber(raw.sell_price),
    stock_qty: toNumber(raw.stock_qty),
    available_stock: toNumber(raw.available_stock),
    units_of_issue: String(raw.units_of_issue ?? 'EACH').trim() || 'EACH',
    updated_at: now,
  };
}

async function upsertBatch(sb, batch) {
  const { error } = await sb.from('products').upsert(batch, { onConflict: 'sku' });
  if (error) throw error;
}

async function main() {
  console.log(`Reading ${numbersPath}...`);
  const rawRows = loadRowsFromNumbers(numbersPath);
  console.log(`Parsed ${rawRows.length} rows`);

  const products = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of rawRows) {
    const row = rowToProduct(raw);
    if (!row) { skipped++; continue; }
    if (seen.has(row.sku)) { skipped++; continue; }
    seen.add(row.sku);
    products.push(row);
  }
  console.log(`Prepared ${products.length} unique SKUs (${skipped} skipped/duplicate)`);

  if (dryRun) {
    console.log('Dry run — sample:', products.slice(0, 3));
    return;
  }

  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let done = 0;
  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    await upsertBatch(sb, batch);
    done += batch.length;
    if (done % 2000 === 0 || done === products.length) {
      console.log(`Upserted ${done}/${products.length}`);
    }
  }

  const { data: syncResult, error: syncErr } = await sb.rpc('sync_website_from_products');
  if (syncErr) {
    console.warn('sync_website_from_products:', syncErr.message);
  } else {
    console.log('sync_website_from_products:', syncResult);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
