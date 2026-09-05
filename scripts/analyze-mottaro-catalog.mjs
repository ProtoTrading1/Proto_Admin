#!/usr/bin/env node
/**
 * Deep analysis of MOTARRO / MOTTARO / MONTTARO catalogue items.
 * Optionally fixes clearly mis-categorized primary paths (Beads/Jewellery outliers).
 *
 * Usage:
 *   node --env-file=.env.vercel scripts/analyze-mottaro-catalog.mjs
 *   node --env-file=.env.vercel scripts/analyze-mottaro-catalog.mjs --apply
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadBundledTaxonomy } from './lib/taxonomy-paths.mjs';
import { inferCategoryPathFromName } from './lib/product-name-category.mjs';
import { inferArtSupplyPath, isArtSupplyProduct } from './lib/art-supplies-paths.mjs';
import { resolvePathFields } from './lib/taxonomy-paths.mjs';
import {
  inferMotarroPathFromRow,
  isMotarroProduct,
} from '../lib/mottaro-category.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const PAGE = 1000;

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

function normPath(row) {
  return [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four]
    .filter((v) => v != null && String(v).trim())
    .join(' > ');
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
    const { data, error } = await sb
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

const seen = new Set();
const all = [...(await loadAll('website_stock')), ...(await loadAll('archived_products'))]
  .filter((r) => {
    if (seen.has(r.sku)) return false;
    seen.add(r.sku);
    return isMotarroProduct(r);
  });

console.log(`\n═══ Mottaro catalogue analysis (${all.length} unique SKUs) ═══\n`);

const primaryPaths = {};
const mottaroPaths = {};
const shallow = [];
const outliers = [];
const fixes = [];

for (const row of all) {
  const primary = normPath(row);
  primaryPaths[primary] = (primaryPaths[primary] || 0) + 1;

  const mp = inferMotarroPathFromRow(row, tree);
  const mpKey = mp.join(' / ');
  mottaroPaths[mpKey] = (mottaroPaths[mpKey] || 0) + 1;

  const depth = [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four]
    .filter((v) => v != null && String(v).trim()).length;
  if (depth <= 2 && row.category === 'Stationery') shallow.push(row);

  const main = String(row.category || '').toLowerCase();
  if (main === 'beads' || main === 'jewellery') outliers.push(row);

  const inferred = isArtSupplyProduct(row.title)
    ? inferArtSupplyPath(row.title)
    : inferCategoryPathFromName(row.title, row.sku, '');
  if (inferred) {
    const target = resolvePathFields(tree, inferred);
    if (target && !fieldsMatch(row, target)) {
      const wrongMain = ['beads', 'jewellery'].includes(main)
        || (main === 'stationery' && depth <= 2 && inferred.includes('Art Supplies'));
      if (wrongMain) fixes.push({ row, target, inferred });
    }
  }
}

console.log('Primary category distribution (top 15):');
Object.entries(primaryPaths).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([p, c]) => console.log(`  ${String(c).padStart(4)}  ${p}`));

console.log('\nVirtual Mottaro browse paths (top 15):');
Object.entries(mottaroPaths).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([p, c]) => console.log(`  ${String(c).padStart(4)}  ${p}`));

console.log(`\nShallow Stationery paths (≤2 levels): ${shallow.length}`);
console.log(`Beads/Jewellery outliers: ${outliers.length}`);
outliers.forEach((r) => console.log(`  ${r.sku}  ${normPath(r)}  —  ${(r.title || '').slice(0, 60)}`));

console.log(`\nSuggested primary-path fixes: ${fixes.length}`);
fixes.slice(0, 20).forEach(({ row, inferred }) => {
  console.log(`  ${row.sku}: ${normPath(row)} → ${inferred}`);
});

const reportLines = [
  'sku,title,primary_path,mottaro_path,is_multi_category',
  ...all.map((r) => {
    const mp = inferMotarroPathFromRow(r, tree).join(' > ');
    const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    return [r.sku, esc(r.title), esc(normPath(r)), esc(mp), 'yes'].join(',');
  }),
];
const reportPath = join(__dir, '../data/mottaro-catalog-analysis.csv');
writeFileSync(reportPath, `${reportLines.join('\n')}\n`);
console.log(`\nFull report: ${reportPath}`);

if (!APPLY) {
  console.log('\nRun with --apply to fix Beads/Jewellery outliers and shallow art-supply misfiles.');
  process.exit(0);
}

let applied = 0;
for (const { row, target } of fixes) {
  const { error } = await sb.from(row.table).update({
    ...target,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);
  if (error) {
    console.warn(`  Failed ${row.sku}:`, error.message);
  } else {
    applied += 1;
    console.log(`  ✓ ${row.sku} → ${target.category} > ${target.subcategory_one}`);
  }
}
console.log(`\nApplied ${applied} primary category fixes.`);
