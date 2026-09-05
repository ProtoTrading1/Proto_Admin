#!/usr/bin/env node
/**
 * Apply SKU → category mappings from an Excel workbook (e.g. "new categories.xlsx").
 *
 * Supports:
 *   • Ribbon-style sheet: SKU + Target Path columns
 *   • Category workbook sheets: Website SKU + Category + Subcategory One…Four
 *   • Auto-detect: picks the sheet with the most SKU+path rows (use --sheet 2 for sheet index 2)
 *
 * Usage:
 *   node scripts/apply-new-categories-xlsx.mjs data/new-categories.xlsx
 *   node scripts/apply-new-categories-xlsx.mjs data/new-categories.xlsx --sheet 2
 *   node scripts/apply-new-categories-xlsx.mjs data/new-categories.xlsx --sheet "Sheet2"
 *   DRY_RUN=false node scripts/apply-new-categories-xlsx.mjs data/new-categories.xlsx --sheet 2
 */

import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadBundledTaxonomy,
  resolvePathFields,
} from './lib/taxonomy-paths.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DEFAULT_FILE = join(ROOT, 'data/new-categories.xlsx');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const PAGE = 1000;

const args = process.argv.slice(2);
let filePath = DEFAULT_FILE;
let sheetArg = null;
let includeAllSheets = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sheet' && args[i + 1]) {
    sheetArg = args[++i];
  } else if (args[i] === '--all-sheets') {
    includeAllSheets = true;
  } else if (!args[i].startsWith('-')) {
    filePath = args[i].startsWith('/') ? args[i] : join(process.cwd(), args[i]);
  }
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  console.error('\nUpload your desktop "new categories" Excel file to:');
  console.error('  data/new-categories.xlsx');
  console.error('\nThen run:');
  console.error('  node scripts/apply-new-categories-xlsx.mjs data/new-categories.xlsx --sheet 2');
  process.exit(1);
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const PATH_OVERRIDES = {
  'OUTSIDE_ELECTRONICS_REVIEW > Jewellery / Beauty Tool': 'Jewellery > Jewellery Tools and Equipment',
};

function resolveTargetPath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  return PATH_OVERRIDES[trimmed] || trimmed;
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

function norm(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (s.toLowerCase() === 'nan') return '';
  return s;
}

function sheetToRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
}

function colIndex(headers, patterns) {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/** Product Manager export: Row Type (CATEGORY|PRODUCT) + Category Path + SKU */
function parseRowTypeExport(sheetName, raw) {
  const mappings = [];
  const errors = [];
  const headers = (raw[0] || []).map((h) => norm(h));
  const rowTypeCol = colIndex(headers, [/^row type$/i]);
  const pathCol = colIndex(headers, [/^category path$/i, /^target path$/i, /^full path$/i]);
  const skuCol = colIndex(headers, [/^sku$/i, /^website sku$/i]);
  if (rowTypeCol < 0 || pathCol < 0 || skuCol < 0) return null;

  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row?.some((c) => norm(c))) continue;
    if (norm(row[rowTypeCol]).toUpperCase() !== 'PRODUCT') continue;

    const sku = norm(row[skuCol]);
    const targetPath = norm(row[pathCol]);
    if (!sku || sku.includes('[OBJECT') || !targetPath) continue;

    mappings.push({ sku, targetPath, source: `${sheetName}:row${r + 1}` });
  }

  return { mappings, errors, rowCount: mappings.length };
}

function extractMappingsFromSheet(sheetName, raw) {
  const rowTypeParsed = parseRowTypeExport(sheetName, raw);
  if (rowTypeParsed?.rowCount) return rowTypeParsed;

  const mappings = [];
  const errors = [];

  let bestCount = 0;
  let bestStart = 0;

  const countAtHeader = (headerRowIdx) => {
    const headers = (raw[headerRowIdx] || []).map((h) => norm(h));
    const skuCol = colIndex(headers, [/^website sku$/i, /^sku$/i]);
    const pathCol = colIndex(headers, [/^corrected proposed path$/i, /^recommended path$/i, /^target path$/i, /^new path$/i, /^full path$/i, /^category path$/i]);
    const catCol = colIndex(headers, [/^category$/i]);
    const sub1Col = colIndex(headers, [/^subcategory one$/i, /^subcategory 1$/i, /^sub 1$/i]);
    if (skuCol < 0) return 0;

    let count = 0;
    for (let r = headerRowIdx + 1; r < raw.length; r++) {
      const row = raw[r];
      if (!row?.some((c) => norm(c))) continue;
      const sku = norm(row[skuCol]);
      if (!sku) continue;

      let targetPath = pathCol >= 0 ? norm(row[pathCol]) : '';
      if (!targetPath && catCol >= 0) {
        const sub2Col = colIndex(headers, [/^subcategory two$/i, /^subcategory 2$/i]);
        const sub3Col = colIndex(headers, [/^subcategory three$/i, /^subcategory 3$/i]);
        const sub4Col = colIndex(headers, [/^subcategory four$/i, /^subcategory 4$/i]);
        const parts = [
          norm(row[catCol]) || sheetName,
          sub1Col >= 0 ? norm(row[sub1Col]) : '',
          sub2Col >= 0 ? norm(row[sub2Col]) : '',
          sub3Col >= 0 ? norm(row[sub3Col]) : '',
          sub4Col >= 0 ? norm(row[sub4Col]) : '',
        ].filter(Boolean);
        if (parts.length >= 2) targetPath = parts.join(' > ');
      }
      if (targetPath) count += 1;
    }
    return count;
  };

  for (let i = 0; i < Math.min(25, raw.length); i++) {
    const c = countAtHeader(i);
    if (c > bestCount) {
      bestCount = c;
      bestStart = i;
    }
  }

  if (bestCount === 0) return { mappings, errors, rowCount: 0 };

  const headers = (raw[bestStart] || []).map((h) => norm(h));
  const skuCol = colIndex(headers, [/^website sku$/i, /^sku$/i]);
  const pathCol = colIndex(headers, [/^corrected proposed path$/i, /^recommended path$/i, /^target path$/i, /^new path$/i, /^full path$/i, /^category path$/i]);
  const catCol = colIndex(headers, [/^category$/i]);
  const sub1Col = colIndex(headers, [/^subcategory one$/i, /^subcategory 1$/i]);
  const sub2Col = colIndex(headers, [/^subcategory two$/i, /^subcategory 2$/i]);
  const sub3Col = colIndex(headers, [/^subcategory three$/i, /^subcategory 3$/i]);
  const sub4Col = colIndex(headers, [/^subcategory four$/i, /^subcategory 4$/i]);

  for (let r = bestStart + 1; r < raw.length; r++) {
    const row = raw[r];
    if (!row?.some((c) => norm(c))) continue;

    const sku = norm(row[skuCol]);
    if (!sku) continue;

    let targetPath = pathCol >= 0 ? norm(row[pathCol]) : '';
    if (!targetPath) {
      const parts = [
        catCol >= 0 ? norm(row[catCol]) : sheetName,
        sub1Col >= 0 ? norm(row[sub1Col]) : '',
        sub2Col >= 0 ? norm(row[sub2Col]) : '',
        sub3Col >= 0 ? norm(row[sub3Col]) : '',
        sub4Col >= 0 ? norm(row[sub4Col]) : '',
      ].filter(Boolean);
      if (parts.length >= 2) targetPath = parts.join(' > ');
    }
    if (!targetPath) continue;

    targetPath = resolveTargetPath(targetPath);

    if (!resolvePathFields(tree, targetPath)) {
      errors.push({ sku, targetPath, source: `${sheetName}:row${r + 1}`, reason: 'invalid_path' });
    }

    mappings.push({ sku, targetPath, source: `${sheetName}:row${r + 1}` });
  }

  return { mappings, errors, rowCount: mappings.length };
}

function parseSheet(sheetName, ws) {
  return extractMappingsFromSheet(sheetName, sheetToRows(ws));
}

function pickSheets(wb) {
  const names = wb.SheetNames;
  if (includeAllSheets) return names;

  if (sheetArg != null) {
    const asNum = Number(sheetArg);
    if (!Number.isNaN(asNum) && asNum >= 1) {
      const idx = asNum - 1;
      if (idx >= names.length) {
        console.error(`Sheet index ${asNum} out of range (${names.length} sheets)`);
        process.exit(1);
      }
      return [names[idx]];
    }
    if (!names.includes(sheetArg)) {
      console.error(`Sheet "${sheetArg}" not found. Available: ${names.join(', ')}`);
      process.exit(1);
    }
    return [sheetArg];
  }

  let best = { name: names[0], count: 0 };
  for (const name of names) {
    const { rowCount } = parseSheet(name, wb.Sheets[name]);
    if (rowCount > best.count) best = { name, count: rowCount };
  }
  return best.count > 0 ? [best.name] : [names[1] ?? names[0]];
}

const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
const sheetNames = pickSheets(wb);

console.log(`File: ${filePath}`);
console.log(`Sheets: ${sheetNames.join(', ')}`);
console.log(`DRY_RUN=${DRY_RUN}\n`);

const skuToMapping = new Map();
const parseErrors = [];

for (const name of sheetNames) {
  const { mappings, errors } = parseSheet(name, wb.Sheets[name]);
  console.log(`  ${name}: ${mappings.length} SKU rows`);
  for (const e of errors) parseErrors.push(e);
  for (const m of mappings) {
    const key = m.sku.toUpperCase();
    if (skuToMapping.has(key) && skuToMapping.get(key).targetPath !== m.targetPath) {
      parseErrors.push({
        sku: m.sku,
        targetPath: m.targetPath,
        source: m.source,
        reason: `conflict_with_${skuToMapping.get(key).source}`,
      });
    } else {
      skuToMapping.set(key, m);
    }
  }
}

if (!skuToMapping.size) {
  console.error('\nNo SKU → category mappings found. Check sheet format (SKU + Target Path, or Website SKU + Category columns).');
  console.error('Available sheets:', wb.SheetNames.join(', '));
  process.exit(1);
}

console.log(`\nUnique SKUs to remap: ${skuToMapping.size}`);

async function loadStockBySku() {
  const bySku = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select('id, sku, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data) {
      const k = String(row.sku || '').trim().toUpperCase();
      if (k) bySku.set(k, row);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return bySku;
}

console.log('Loading website_stock…');
const stockBySku = await loadStockBySku();
console.log(`Loaded ${stockBySku.size} products.\n`);

const updates = [];
const notFound = [];
const invalidPath = [];
const unchanged = [];

for (const [skuKey, mapping] of skuToMapping) {
  const fields = resolvePathFields(tree, mapping.targetPath);
  if (!fields) {
    invalidPath.push({ ...mapping, reason: 'invalid_path' });
    continue;
  }

  const row = stockBySku.get(skuKey);
  if (!row) {
    notFound.push(mapping);
    continue;
  }

  const same =
    row.category === fields.category &&
    (row.subcategory_one || null) === (fields.subcategory_one || null) &&
    (row.subcategory_two || null) === (fields.subcategory_two || null) &&
    (row.subcategory_three || null) === (fields.subcategory_three || null) &&
    (row.subcategory_four || null) === (fields.subcategory_four || null);

  if (same) {
    unchanged.push({ sku: mapping.sku, targetPath: mapping.targetPath });
    continue;
  }

  updates.push({
    id: row.id,
    sku: mapping.sku,
    targetPath: mapping.targetPath,
    fields,
    old: {
      category: row.category,
      subcategory_one: row.subcategory_one,
      subcategory_two: row.subcategory_two,
      subcategory_three: row.subcategory_three,
    },
  });
}

console.log('Summary:');
console.log(`  ${updates.length} to update`);
console.log(`  ${unchanged.length} already correct`);
console.log(`  ${notFound.length} SKU not in website_stock`);
console.log(`  ${invalidPath.length} invalid target paths`);
console.log(`  ${parseErrors.length} parse warnings`);

if (updates.length) {
  console.log('\nSample updates:');
  for (const u of updates.slice(0, 8)) {
    console.log(`  ${u.sku}: ${u.old.category} > ${u.old.subcategory_one || ''} → ${u.targetPath}`);
  }
}

const reportLines = [
  'type,sku,target_path,detail',
  ...notFound.map((m) => `not_found,${JSON.stringify(m.sku)},${JSON.stringify(m.targetPath)},${JSON.stringify(m.source)}`),
  ...invalidPath.map((m) => `invalid_path,${JSON.stringify(m.sku)},${JSON.stringify(m.targetPath)},`),
  ...parseErrors.map((e) => `parse_error,${JSON.stringify(e.sku)},${JSON.stringify(e.targetPath || '')},${JSON.stringify(e.reason)}`),
];
const reportPath = join(ROOT, 'data/new-categories-report.csv');
writeFileSync(reportPath, reportLines.join('\n'));
console.log(`\nReport: ${reportPath}`);

if (DRY_RUN) {
  console.log('\nDRY RUN — no DB changes. Re-run with DRY_RUN=false to apply.');
  process.exit(updates.length ? 0 : 1);
}

let done = 0;
for (const u of updates) {
  const { error } = await supabase
    .from('website_stock')
    .update({
      ...u.fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', u.id);
  if (error) console.error(`  ✗ ${u.sku}: ${error.message}`);
  else done += 1;
}

console.log(`\n✓ Applied ${done}/${updates.length} category updates.`);
