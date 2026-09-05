#!/usr/bin/env node
/**
 * Apply path → path category remaps from Excel (Current Path / Proposed Existing Path / Product Count).
 *
 * Usage:
 *   node scripts/apply-path-remap-xlsx.mjs path/to/file.xlsx
 *   DRY_RUN=false node scripts/apply-path-remap-xlsx.mjs path/to/file.xlsx
 */

import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadBundledTaxonomy, resolvePathFields } from './lib/taxonomy-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const PAGE = 1000;

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/apply-path-remap-xlsx.mjs <file.xlsx>');
  process.exit(1);
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

function norm(v) {
  return String(v ?? '').trim();
}

function normPath(s) {
  return String(s ?? '').trim().toLowerCase();
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

function pathMatches(productPathStr, currentPath) {
  const p = normPath(productPathStr);
  const c = normPath(currentPath);
  return p === c || p.startsWith(`${c} >`);
}

const PATH_OVERRIDES = {
  'packaging & storage > packaging packets and bags > plastic carrier bags':
    'Packaging & Storage > Packaging Packets and Bags > Ziplock',
};

function parseRows(wb) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headers = (raw[0] || []).map((h) => norm(h).toLowerCase());
  const currentCol = headers.findIndex((h) => h === 'current path');
  const proposedCol = headers.findIndex((h) => h.includes('proposed'));
  const decisionCol = headers.findIndex((h) => h === 'decision');
  const countCol = headers.findIndex((h) => h.includes('product count') || h === 'count');

  if (currentCol < 0 || proposedCol < 0) {
    throw new Error('Expected columns: Current Path, Proposed Existing Path');
  }

  const rules = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row?.some((c) => norm(c))) continue;
    const currentPath = norm(row[currentCol]);
    const proposedPath = norm(row[proposedCol]);
    const decision = decisionCol >= 0 ? norm(row[decisionCol]) : '';
    const count = countCol >= 0 ? Number(row[countCol]) || 0 : 0;
    if (!currentPath || !proposedPath) continue;
    rules.push({ currentPath, proposedPath, decision, count, row: i + 1 });
  }
  return rules;
}

async function loadProducts() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select('id, sku, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data?.length || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
const rules = parseRows(wb);

console.log(`File: ${filePath}`);
console.log(`DRY_RUN=${DRY_RUN}`);
console.log(`Rules: ${rules.length}\n`);

const moveRules = rules.filter((r) => !/^KEEP_/i.test(r.decision));
const keepRules = rules.filter((r) => /^KEEP_/i.test(r.decision));
console.log(`  ${moveRules.length} move rules, ${keepRules.length} keep rules`);

console.log('Loading website_stock…');
const products = await loadProducts();
console.log(`Loaded ${products.length} products.\n`);

const assigned = new Set();
const updates = [];
const invalidPaths = [];
const shortfalls = [];

for (const rule of moveRules) {
  const override = PATH_OVERRIDES[normPath(rule.proposedPath)];
  const targetPath = override || rule.proposedPath;
  const fields = resolvePathFields(tree, targetPath);
  if (!fields) {
    invalidPaths.push({ ...rule, proposedPath: targetPath });
    continue;
  }

  const pool = products.filter((p) => !assigned.has(p.id) && pathMatches(productPath(p), rule.currentPath));
  const take = rule.count > 0 ? Math.min(rule.count, pool.length) : pool.length;

  if (rule.count > 0 && pool.length < rule.count) {
    shortfalls.push({ ...rule, available: pool.length });
  }

  for (const p of pool.slice(0, take)) {
    assigned.add(p.id);
    const same =
      p.category === fields.category &&
      (p.subcategory_one || null) === (fields.subcategory_one || null) &&
      (p.subcategory_two || null) === (fields.subcategory_two || null) &&
      (p.subcategory_three || null) === (fields.subcategory_three || null) &&
      (p.subcategory_four || null) === (fields.subcategory_four || null);
    if (!same) {
      updates.push({
        id: p.id,
        sku: p.sku,
        from: productPath(p),
        to: targetPath,
        fields,
      });
    }
  }
}

console.log('Summary:');
console.log(`  ${updates.length} products to update`);
console.log(`  ${assigned.size} products assigned by move rules`);
console.log(`  ${invalidPaths.length} invalid proposed paths`);
console.log(`  ${shortfalls.length} shortfalls (fewer products than count)`);

if (updates.length) {
  console.log('\nSample updates:');
  for (const u of updates.slice(0, 10)) {
    console.log(`  ${u.sku}: ${u.from} → ${u.to}`);
  }
}

if (shortfalls.length) {
  console.log('\nShortfalls:');
  for (const s of shortfalls) {
    console.log(`  row ${s.row}: need ${s.count}, found ${s.available} at "${s.currentPath}"`);
  }
}

if (invalidPaths.length) {
  console.log('\nInvalid paths:');
  for (const r of invalidPaths) {
    console.log(`  row ${r.row}: ${r.proposedPath}`);
  }
}

const reportPath = join(ROOT, 'data/new-44-path-remap-report.csv');
const lines = [
  'sku,from_path,to_path',
  ...updates.map((u) => `${JSON.stringify(u.sku)},${JSON.stringify(u.from)},${JSON.stringify(u.to)}`),
];
writeFileSync(reportPath, lines.join('\n'));
console.log(`\nReport: ${reportPath}`);

if (DRY_RUN) {
  console.log('\nDRY RUN — no DB changes. Re-run with DRY_RUN=false to apply.');
  process.exit(updates.length ? 0 : 1);
}

let done = 0;
for (const u of updates) {
  const { error } = await supabase
    .from('website_stock')
    .update({ ...u.fields, updated_at: new Date().toISOString() })
    .eq('id', u.id);
  if (error) console.error(`  ✗ ${u.sku}: ${error.message}`);
  else done += 1;
}

console.log(`\n✓ Applied ${done}/${updates.length} category updates.`);
