#!/usr/bin/env node
/**
 * Move easels, paintbrushes, canvas, paints etc. from Stationery to Arts and Crafts.
 *
 * Usage:
 *   node scripts/fix-art-supplies-categories.mjs [--apply] [--apply-if-pending]
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadBundledTaxonomy, resolvePathFields } from './lib/taxonomy-paths.mjs';
import { inferArtSupplyPath, isArtSupplyProduct } from './lib/art-supplies-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PENDING_FILE = join(ROOT, 'data/art-supplies-fix.pending');
const PAGE = 1000;

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const APPLY_IF_PENDING = args.has('--apply-if-pending');

if (APPLY_IF_PENDING && !existsSync(PENDING_FILE)) {
  console.log('No art-supplies-fix.pending — skipping.');
  process.exit(0);
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  if (APPLY_IF_PENDING) {
    console.warn('Skipping art supplies fix — missing Supabase credentials.');
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
  return [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four]
    .map(norm).filter(Boolean).join(' > ');
}

function fieldsMatch(row, fields) {
  return row.category === fields.category
    && (row.subcategory_one || null) === (fields.subcategory_one || null)
    && (row.subcategory_two || null) === (fields.subcategory_two || null)
    && (row.subcategory_three || null) === (fields.subcategory_three || null)
    && (row.subcategory_four || null) === (fields.subcategory_four || null);
}

async function loadAll(table) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, sku, title, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data || []) rows.push({ ...row, table });
    if (!data?.length || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

console.log('Scanning catalogue for art supplies misplaced under Stationery…');
const allRows = [...(await loadAll('website_stock')), ...(await loadAll('archived_products'))];

const updates = [];
const alreadyCorrect = [];

for (const row of allRows) {
  const title = row.title || '';
  if (!isArtSupplyProduct(title)) continue;
  if (row.category === 'Arts and Crafts') {
    const targetPath = inferArtSupplyPath(title);
    const resolved = targetPath ? resolvePathFields(tree, targetPath) : null;
    if (resolved && fieldsMatch(row, resolved)) alreadyCorrect.push(row.sku);
    continue;
  }

  const targetPath = inferArtSupplyPath(title);
  if (!targetPath) continue;
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
console.log(`  ${alreadyCorrect.length} already in Arts and Crafts`);

if (updates.length) {
  const byTarget = {};
  for (const u of updates) byTarget[u.targetPath] = (byTarget[u.targetPath] || 0) + 1;
  console.log('\nBy destination:');
  Object.entries(byTarget).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => console.log(`  ${c}  ${p}`));
}

const shouldApply = APPLY || APPLY_IF_PENDING;
if (!shouldApply) {
  console.log('\nDRY RUN — no DB changes.');
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

console.log(`\n✓ Applied ${done}/${updates.length} art supply category fixes.`);

if (APPLY_IF_PENDING && done === updates.length && existsSync(PENDING_FILE)) {
  unlinkSync(PENDING_FILE);
  console.log('Removed data/art-supplies-fix.pending');
}

process.exit(done === updates.length ? 0 : 1);
