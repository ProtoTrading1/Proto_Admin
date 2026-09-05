#!/usr/bin/env node
/**
 * Re-map stationery writing products into Writing & Correction subcategories.
 *
 * Usage:
 *   node scripts/fix-writing-correction-categories.mjs
 *   node scripts/fix-writing-correction-categories.mjs --apply
 *   node scripts/fix-writing-correction-categories.mjs --apply-if-pending
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadBundledTaxonomy, resolvePathFields } from './lib/taxonomy-paths.mjs';
import { inferWritingCorrectionPath, isWritingCorrectionProduct } from './lib/writing-correction-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PENDING_FILE = join(ROOT, 'data/writing-correction-fix.pending');
const PAGE = 1000;

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const APPLY_IF_PENDING = args.has('--apply-if-pending');

if (APPLY_IF_PENDING && !existsSync(PENDING_FILE)) {
  console.log('No writing-correction-fix.pending — skipping.');
  process.exit(0);
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  if (APPLY_IF_PENDING) {
    console.warn('Skipping writing correction fix — missing Supabase credentials.');
    process.exit(0);
  }
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

function norm(v) {
  if (v == null) return '';
  return String(v).trim();
}

function productPath(row) {
  return [
    row.category,
    row.subcategory_one,
    row.subcategory_two,
    row.subcategory_three,
    row.subcategory_four,
  ].map(norm).filter(Boolean).join(' > ');
}

function fieldsMatch(row, fields) {
  return row.category === fields.category
    && (row.subcategory_one || null) === (fields.subcategory_one || null)
    && (row.subcategory_two || null) === (fields.subcategory_two || null)
    && (row.subcategory_three || null) === (fields.subcategory_three || null)
    && (row.subcategory_four || null) === (fields.subcategory_four || null);
}

async function loadTable(table) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, sku, title, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .eq('category', 'Stationery')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data || []) rows.push({ ...row, table });
    if (!data?.length || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

console.log('Loading Stationery products for writing/correction remap…');
const allRows = [
  ...(await loadTable('website_stock')),
  ...(await loadTable('archived_products')),
];
console.log(`Scanned ${allRows.length} stationery rows.\n`);

const updates = [];
const alreadyCorrect = [];
const skipped = [];

for (const row of allRows) {
  const title = row.title || '';
  if (!isWritingCorrectionProduct(title)) continue;

  const targetPath = inferWritingCorrectionPath(title);
  if (!targetPath) {
    skipped.push({ sku: row.sku, title });
    continue;
  }

  const resolved = resolvePathFields(tree, targetPath);
  if (!resolved) {
    console.warn(`  Invalid path for ${row.sku}: ${targetPath}`);
    continue;
  }

  if (fieldsMatch(row, resolved)) {
    alreadyCorrect.push(row.sku);
    continue;
  }

  updates.push({
    table: row.table,
    id: row.id,
    sku: row.sku,
    title,
    from: productPath(row),
    targetPath,
    fields: resolved,
  });
}

console.log('Summary:');
console.log(`  ${updates.length} to update`);
console.log(`  ${alreadyCorrect.length} already correct`);
console.log(`  ${skipped.length} skipped (excluded titles)`);

if (updates.length) {
  const byTarget = {};
  for (const u of updates) byTarget[u.targetPath] = (byTarget[u.targetPath] || 0) + 1;
  console.log('\nBy destination:');
  Object.entries(byTarget).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => console.log(`  ${c}  ${p}`));
  console.log('\nSample updates:');
  for (const u of updates.slice(0, 20)) {
    console.log(`  [${u.table}] ${u.sku}: ${u.from} → ${u.targetPath}`);
  }
}

const shouldApply = APPLY || APPLY_IF_PENDING;
if (!shouldApply) {
  console.log('\nDRY RUN — no DB changes. Re-run with --apply to commit.');
  process.exit(0);
}

let done = 0;
for (const u of updates) {
  const { error } = await supabase
    .from(u.table)
    .update({ ...u.fields, updated_at: new Date().toISOString() })
    .eq('id', u.id);
  if (error) console.error(`  ✗ ${u.sku}: ${error.message}`);
  else done += 1;
}

console.log(`\n✓ Applied ${done}/${updates.length} writing/correction category fixes.`);

if (APPLY_IF_PENDING && done === updates.length && existsSync(PENDING_FILE)) {
  unlinkSync(PENDING_FILE);
  console.log('Removed data/writing-correction-fix.pending');
}

process.exit(done === updates.length ? 0 : 1);
