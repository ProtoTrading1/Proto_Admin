#!/usr/bin/env node
/**
 * Apply per-SKU category moves from Category Move Excel workbooks.
 *
 * Supports:
 *   • Move 1: Website SKU + Proposed Existing Path (+ Move Needed = YES)
 *   • Move 2: SKU + Final Main Category / Final Category / Final Subcategory
 *   • Move 3: SKU + Final Main Menu / Final Kid 1–4 (+ Recommended Action)
 *   • Move 5: SKU + Proposed Path (+ Decision contains MOVE) — stationery review sheet
 *
 * Usage:
 *   node scripts/apply-category-move-xlsx.mjs data/category-move-1.xlsx data/category-move-2.xlsx
 *   node scripts/apply-category-move-xlsx.mjs --bundled
 *   node scripts/apply-category-move-xlsx.mjs --bundled --apply
 *   node scripts/apply-category-move-xlsx.mjs --apply-if-pending   # Vercel build hook
 */

import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  labelsToDbFields,
  loadBundledTaxonomy,
  pathStringToLabels,
  resolvePathFields,
} from './lib/taxonomy-paths.mjs';
import { parseExtraLabels } from '../lib/taxonomy-match.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PENDING_FILE = join(ROOT, 'data/category-moves.pending');
const MOVE5_PENDING_FILE = join(ROOT, 'data/category-move-5.pending');
const MOVE5_FILE = join(ROOT, 'data/category-move-5.xlsx');
const BUNDLED_FILES = [
  join(ROOT, 'data/category-move-1.xlsx'),
  join(ROOT, 'data/category-move-2.xlsx'),
];

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const BUNDLED = args.has('--bundled');
const APPLY_IF_PENDING = args.has('--apply-if-pending');
const DRY_RUN = !APPLY && !APPLY_IF_PENDING;
const PAGE = 1000;

const filePaths = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function resolveInputFiles() {
  if (APPLY_IF_PENDING) {
    const files = [];
    if (existsSync(PENDING_FILE)) files.push(...BUNDLED_FILES);
    if (existsSync(MOVE5_PENDING_FILE) && existsSync(MOVE5_FILE)) files.push(MOVE5_FILE);
    return files;
  }
  if (BUNDLED) return BUNDLED_FILES;
  return filePaths;
}

const inputFiles = resolveInputFiles();

if (APPLY_IF_PENDING && !inputFiles.length) {
  console.log('No pending category moves — skipping.');
  process.exit(0);
}

if (!inputFiles.length) {
  console.error('Usage: node scripts/apply-category-move-xlsx.mjs [--bundled] [--apply] <file.xlsx> [...]');
  process.exit(1);
}

for (const f of inputFiles) {
  if (!existsSync(f)) {
    console.error(`File not found: ${f}`);
    process.exit(1);
  }
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  if (APPLY_IF_PENDING) {
    console.warn('Skipping category moves — missing Supabase credentials.');
    process.exit(0);
  }
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

const SEGMENT_LABELS = {
  textiles: 'Textiles',
  petersham: 'Petersham',
  organza: 'Organza',
  satin: 'Satin',
  natural: 'Natural',
  'acrylic & blends': 'Acrylic & Blends',
  ribbon: 'Ribbon',
  yarn: 'Yarn',
  wool: 'Wool',
};

/** Move 3: normalize Excel destination paths to catalogue taxonomy */
function buildMove3TargetPath(parts) {
  const raw = parts.map(norm).filter(Boolean);
  if (!raw.length) return '';

  let labels = raw;
  if (raw[0].toLowerCase() === 'out of beads') {
    labels = raw.slice(1);
  } else if (raw[0].toLowerCase() === 'beads & jewellery making') {
    labels = ['Beads', ...raw.slice(1)];
  }

  if (labels[0]?.toLowerCase() === 'packaging & display') {
    labels[0] = 'Packaging & Storage';
  }
  if (labels[0]?.toLowerCase() === 'watches') {
    return 'Electronics & Accessories > Clocks & Watches > Watches';
  }

  return labels.join(' > ');
}

const BEAD_MATERIAL_PATHS = {
  'glass / crystal / pearl': 'Beads > Glass & Crystal',
  'plastic / acrylic / ccb': 'Beads > Plastic & Crystal',
  'stone / natural': 'Beads > Natural',
  metal: 'Beads > Metal',
  wood: 'Beads > Wood',
};

function inferFindingsPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (/EARRING\s*HOOK|EAR\s*HOOP/.test(n)) return 'Jewellery > Findings > Earring Hooks';
  if (/CLASP|CALOTTE/.test(n)) return 'Jewellery > Findings > Clasps';
  if (/CRIMP/.test(n)) return 'Jewellery > Findings > Crimps';
  if (/JUMPRING|JUMP\s*RING/.test(n)) return 'Jewellery > Findings > Jumprings & Split Rings';
  if (/EYEPIN|EYE\s*PIN|HEAD\s*PIN|HEADPIN/.test(n)) return 'Jewellery > Findings > Eye & Head Pins';
  if (/\bCHAIN\b/.test(n)) return 'Jewellery > Findings > Stringing Materials > Chain';
  if (/THREAD/.test(n)) return 'Jewellery > Findings > Stringing Materials > Threads';
  if (/\bWIRE\b/.test(n)) return 'Jewellery > Findings > Stringing Materials > Wire';
  if (/ELASTIC/.test(n)) return 'Jewellery > Findings > Stringing Materials > Elastic';
  if (/\bCORD\b/.test(n)) return 'Jewellery > Findings > Stringing Materials > Cord';
  if (/\bRING\b/.test(n) && !/JUMPRING|EARRING/.test(n)) return 'Jewellery > Findings > Rings';
  return 'Jewellery > Findings';
}

/** Move 3: split into material / product-type subcategories (catalogue SKUs only). */
function buildMove3SubdividedTargetPath(row) {
  const finalKid1 = norm(row['Final Kid 1']);
  const finalKid2 = norm(row['Final Kid 2']);
  const suggestedKid3 = norm(row['Suggested Kid 3']).toLowerCase();
  const productName = norm(row.ProductName || row['Product name']);

  if (finalKid1 === 'Beads By Material' && finalKid2 === 'Beads') {
    const materialPath = BEAD_MATERIAL_PATHS[suggestedKid3];
    if (materialPath) return materialPath;
    return buildMove3TargetPath(['Beads & Jewellery Making', finalKid1, finalKid2]);
  }

  if (finalKid1 === 'Seed Beads') {
    return 'Beads > Glass & Crystal > Seed Beads';
  }

  if (finalKid2 === 'Findings / Components') {
    return inferFindingsPath(productName);
  }

  if (finalKid2 === 'Display / Packaging') {
    if (/TAG/i.test(productName)) return 'Packaging & Storage > Tags > Jewellery';
    if (/DISPLAY|STAND/i.test(productName)) return 'Packaging & Storage > Display > Jewellery';
    return buildMove3TargetPath(['Out of Beads', 'Packaging & Display', finalKid2]);
  }

  if (finalKid2 === 'Finished Jewellery') {
    return 'Jewellery > Jewellery';
  }

  const parts = [
    row['Final Main Menu'],
    row['Final Kid 1'],
    row['Final Kid 2'],
    row['Final Kid 3'],
    row['Final Kid 4'],
  ].map(norm).filter(Boolean);
  return buildMove3TargetPath(parts);
}

function norm(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (s.toLowerCase() === 'nan') return '';
  return s;
}

function normalizeSku(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Excel sometimes parses dash SKUs like 12-2006 as dates.
    return `${v.getUTCMonth() + 1}-${v.getUTCFullYear()}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  return norm(v);
}

function normalizeSegment(label) {
  const key = norm(label).toLowerCase();
  return SEGMENT_LABELS[key] || norm(label).replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, 'and');
}

function productPath(row) {
  return [
    row.category,
    row.subcategory_one,
    row.subcategory_two,
    row.subcategory_three,
    row.subcategory_four,
    ...parseExtraLabels(row.subcategory_extra),
  ].map(norm).filter(Boolean).join(' > ');
}

function fieldsMatch(row, fields) {
  return (
    row.category === fields.category
    && (row.subcategory_one || null) === (fields.subcategory_one || null)
    && (row.subcategory_two || null) === (fields.subcategory_two || null)
    && (row.subcategory_three || null) === (fields.subcategory_three || null)
    && (row.subcategory_four || null) === (fields.subcategory_four || null)
    && (row.subcategory_extra || null) === (fields.subcategory_extra || null)
  );
}

function resolveTargetFields(targetPath) {
  const strict = resolvePathFields(tree, targetPath);
  if (strict) return { fields: strict, targetPath };

  const labels = pathStringToLabels(targetPath).map(normalizeSegment);
  if (labels.length >= 2) {
    const main = labels[0]?.toLowerCase();
    if (main === 'textiles' || main === 'beads' || main === 'jewellery' || main === 'packaging & storage' || main === 'electronics & accessories' || main === 'stationery') {
      return { fields: labelsToDbFields(labels), targetPath: labels.join(' > ') };
    }
  }

  return null;
}

function colIndex(headers, patterns) {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

function parseMove5(filePath, raw) {
  const mappings = [];
  const headers = (raw[0] || []).map((h) => norm(h));
  const skuCol = colIndex(headers, [/^sku$/i, /^website sku$/i]);
  const pathCol = colIndex(headers, [/^proposed path$/i]);
  const decisionCol = colIndex(headers, [/^decision$/i]);
  if (skuCol < 0 || pathCol < 0) return mappings;

  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row?.some((c) => norm(c))) continue;
    if (decisionCol >= 0) {
      const decision = norm(row[decisionCol]).toUpperCase();
      if (decision && !/MOVE/i.test(decision)) continue;
    }

    const sku = normalizeSku(row[skuCol]);
    const targetPath = norm(row[pathCol]);
    if (!sku || !targetPath) continue;
    mappings.push({ sku, targetPath, source: `${filePath}:row${r + 1}` });
  }
  return mappings;
}

function parseMove1(filePath, raw) {
  const mappings = [];
  const headers = (raw[0] || []).map((h) => norm(h));
  const skuCol = colIndex(headers, [/^website sku$/i, /^sku$/i]);
  const pathCol = colIndex(headers, [/^proposed existing path$/i, /^target path$/i]);
  const moveCol = colIndex(headers, [/^move needed$/i]);
  if (skuCol < 0 || pathCol < 0) return mappings;

  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row?.some((c) => norm(c))) continue;
    if (moveCol >= 0 && norm(row[moveCol]).toUpperCase() !== 'YES') continue;

    const sku = normalizeSku(row[skuCol]);
    const targetPath = norm(row[pathCol]);
    if (!sku || !targetPath) continue;
    mappings.push({ sku, targetPath, source: `${filePath}:row${r + 1}` });
  }
  return mappings;
}

function parseMove3(filePath, sheet) {
  const mappings = [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Object.values(row).some((c) => norm(c))) continue;
    if (norm(row['Recommended Action']) && !/move/i.test(norm(row['Recommended Action']))) continue;

    const sku = normalizeSku(row.SKU);
    if (!sku) continue;

    const targetPath = buildMove3SubdividedTargetPath(row);
    if (!targetPath) continue;
    mappings.push({ sku, targetPath, source: `${filePath}:row${i + 2}` });
  }
  return mappings;
}

function parseMove2(filePath, raw) {
  const mappings = [];
  const headers = (raw[0] || []).map((h) => norm(h));
  const skuCol = colIndex(headers, [/^website sku$/i, /^sku$/i]);
  const mainCol = colIndex(headers, [/^final main category$/i]);
  const catCol = colIndex(headers, [/^final category$/i]);
  const subCol = colIndex(headers, [/^final subcategory$/i]);
  if (skuCol < 0 || mainCol < 0 || catCol < 0 || subCol < 0) return mappings;

  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row?.some((c) => norm(c))) continue;
    const sku = normalizeSku(row[skuCol]);
    const parts = [norm(row[mainCol]), norm(row[catCol]), norm(row[subCol])].filter(Boolean);
    if (!sku || parts.length < 3) continue;
    const targetPath = parts.map(normalizeSegment).join(' > ');
    mappings.push({ sku, targetPath, source: `${filePath}:row${r + 1}` });
  }
  return mappings;
}

function parseWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  const headers = (raw[0] || []).map((h) => norm(h).toLowerCase());

  if (headers.includes('proposed path') && headers.includes('current path')) {
    return { type: 'move5', mappings: parseMove5(filePath, raw) };
  }
  if (headers.includes('proposed existing path')) {
    return { type: 'move1', mappings: parseMove1(filePath, raw) };
  }
  if (headers.includes('final main category')) {
    return { type: 'move2', mappings: parseMove2(filePath, raw) };
  }
  if (headers.includes('final main menu')) {
    return { type: 'move3', mappings: parseMove3(filePath, sheet) };
  }
  throw new Error(`Unrecognized workbook format: ${filePath}`);
}

const skuToMapping = new Map();
const conflicts = [];

for (const filePath of inputFiles) {
  const { type, mappings } = parseWorkbook(filePath);
  console.log(`${filePath} (${type}): ${mappings.length} move rows`);
  for (const m of mappings) {
    const key = m.sku.toUpperCase();
    if (skuToMapping.has(key) && skuToMapping.get(key).targetPath !== m.targetPath) {
      conflicts.push({ sku: m.sku, a: skuToMapping.get(key), b: m });
    } else {
      skuToMapping.set(key, m);
    }
  }
}

if (!skuToMapping.size) {
  console.error('No SKU mappings found.');
  process.exit(1);
}

console.log(`\nUnique SKUs: ${skuToMapping.size}`);
if (conflicts.length) {
  console.error(`Conflicting SKU targets: ${conflicts.length}`);
  for (const c of conflicts.slice(0, 5)) console.error(`  ${c.sku}`);
  process.exit(1);
}

async function loadTableBySku(table) {
  const bySku = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('id, sku, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four, subcategory_extra')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data || []) {
      const k = normalizeSku(row.sku).toUpperCase();
      if (k) bySku.set(k, { ...row, table });
    }
    if (!data?.length || data.length < PAGE) break;
    from += PAGE;
  }
  return bySku;
}

console.log('Loading website_stock + archived_products…');
const [liveBySku, archivedBySku] = await Promise.all([
  loadTableBySku('website_stock'),
  loadTableBySku('archived_products'),
]);
console.log(`Loaded ${liveBySku.size} live, ${archivedBySku.size} archived.\n`);

const updates = [];
const notFound = [];
const invalidPath = [];
const unchanged = [];

for (const [skuKey, mapping] of skuToMapping) {
  const resolved = resolveTargetFields(mapping.targetPath);
  if (!resolved) {
    invalidPath.push(mapping);
    continue;
  }

  const row = liveBySku.get(skuKey) || archivedBySku.get(skuKey);
  if (!row) {
    notFound.push(mapping);
    continue;
  }

  if (fieldsMatch(row, resolved.fields)) {
    unchanged.push({ sku: mapping.sku, targetPath: resolved.targetPath });
    continue;
  }

  updates.push({
    table: row.table,
    id: row.id,
    sku: mapping.sku,
    from: productPath(row),
    targetPath: resolved.targetPath,
    fields: resolved.fields,
    source: mapping.source,
  });
}

console.log('Summary:');
console.log(`  ${updates.length} to update`);
console.log(`  ${unchanged.length} already correct`);
console.log(`  ${notFound.length} SKU not found`);
console.log(`  ${invalidPath.length} invalid target paths`);

if (updates.length) {
  console.log('\nSample updates:');
  for (const u of updates.slice(0, 10)) {
    console.log(`  [${u.table}] ${u.sku}: ${u.from} → ${u.targetPath}`);
  }
}

const reportPath = join(ROOT, 'data/category-moves-report.csv');
const reportLines = [
  'status,table,sku,from_path,to_path,source',
  ...updates.map((u) => `update,${u.table},${JSON.stringify(u.sku)},${JSON.stringify(u.from)},${JSON.stringify(u.targetPath)},${JSON.stringify(u.source)}`),
  ...unchanged.map((u) => `unchanged,,${JSON.stringify(u.sku)},,${JSON.stringify(u.targetPath)},`),
  ...notFound.map((m) => `not_found,,${JSON.stringify(m.sku)},,${JSON.stringify(m.targetPath)},${JSON.stringify(m.source)}`),
  ...invalidPath.map((m) => `invalid_path,,${JSON.stringify(m.sku)},,${JSON.stringify(m.targetPath)},${JSON.stringify(m.source)}`),
];
writeFileSync(reportPath, reportLines.join('\n'));
console.log(`\nReport: ${reportPath}`);

const shouldApply = APPLY || APPLY_IF_PENDING;
if (!shouldApply) {
  console.log('\nDRY RUN — no DB changes. Re-run with --apply to commit.');
  process.exit(updates.length ? 0 : 1);
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

console.log(`\n✓ Applied ${done}/${updates.length} category updates.`);

if (APPLY_IF_PENDING) {
  if (existsSync(PENDING_FILE) && inputFiles.some((f) => BUNDLED_FILES.includes(f)) && done === updates.length) {
    unlinkSync(PENDING_FILE);
    console.log('Removed data/category-moves.pending');
  }
  if (existsSync(MOVE5_PENDING_FILE) && inputFiles.includes(MOVE5_FILE) && done === updates.length) {
    unlinkSync(MOVE5_PENDING_FILE);
    console.log('Removed data/category-move-5.pending');
  }
}

if (APPLY_IF_PENDING) {
  if (done < updates.length) {
    console.warn(`Warning: ${updates.length - done} updates failed — build will continue.`);
  }
  process.exit(0);
}

process.exit(done === updates.length ? 0 : 1);
