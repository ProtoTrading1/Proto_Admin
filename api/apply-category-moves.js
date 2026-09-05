import { requireCronOrAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import XLSX from 'xlsx';
import {
  labelsToDbFields,
  loadBundledTaxonomy,
  pathStringToLabels,
  resolvePathFields,
} from '../scripts/lib/taxonomy-paths.mjs';
import { parseExtraLabels } from '../lib/taxonomy-match.mjs';

const ROOT = process.cwd();
const PENDING_FILE = join(ROOT, 'data/category-moves.pending');
const BUNDLED_FILES = [
  join(ROOT, 'data/category-move-1.xlsx'),
  join(ROOT, 'data/category-move-2.xlsx'),
];
const PAGE = 1000;

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

function norm(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeSku(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  return norm(v);
}

function normalizeSegment(label) {
  const key = norm(label).toLowerCase();
  return SEGMENT_LABELS[key] || norm(label).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function productPath(row) {
  return [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four,
    ...parseExtraLabels(row.subcategory_extra)]
    .map(norm).filter(Boolean).join(' > ');
}

function fieldsMatch(row, fields) {
  return row.category === fields.category
    && (row.subcategory_one || null) === (fields.subcategory_one || null)
    && (row.subcategory_two || null) === (fields.subcategory_two || null)
    && (row.subcategory_three || null) === (fields.subcategory_three || null)
    && (row.subcategory_four || null) === (fields.subcategory_four || null)
    && (row.subcategory_extra || null) === (fields.subcategory_extra || null);
}

function resolveTargetFields(tree, targetPath) {
  const strict = resolvePathFields(tree, targetPath);
  if (strict) return { fields: strict, targetPath };
  const labels = pathStringToLabels(targetPath).map(normalizeSegment);
  if (labels[0]?.toLowerCase() === 'textiles' && labels.length >= 2) {
    const canonical = [SEGMENT_LABELS.textiles, ...labels.slice(1)];
    return { fields: labelsToDbFields(canonical), targetPath: canonical.join(' > ') };
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

function parseMove1(filePath, raw) {
  const mappings = [];
  const headers = (raw[0] || []).map((h) => norm(h));
  const skuCol = colIndex(headers, [/^website sku$/i, /^sku$/i]);
  const pathCol = colIndex(headers, [/^proposed existing path$/i]);
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
    mappings.push({ sku, targetPath: parts.map(normalizeSegment).join(' > '), source: `${filePath}:row${r + 1}` });
  }
  return mappings;
}

function loadMappings() {
  const skuToMapping = new Map();
  for (const filePath of BUNDLED_FILES) {
    if (!existsSync(filePath)) continue;
    const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
    const headers = (raw[0] || []).map((h) => norm(h).toLowerCase());
    const mappings = headers.includes('proposed existing path')
      ? parseMove1(filePath, raw)
      : parseMove2(filePath, raw);
    for (const m of mappings) skuToMapping.set(m.sku.toUpperCase(), m);
  }
  return skuToMapping;
}

async function loadTableBySku(supabase, table) {
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

export async function applyCategoryMoves({ dryRun = false } = {}) {
  const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing stock Supabase credentials');

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const tree = loadBundledTaxonomy();
  const skuToMapping = loadMappings();
  if (!skuToMapping.size) throw new Error('No SKU mappings in bundled workbooks');

  const [liveBySku, archivedBySku] = await Promise.all([
    loadTableBySku(supabase, 'website_stock'),
    loadTableBySku(supabase, 'archived_products'),
  ]);

  const updates = [];
  const notFound = [];
  const invalidPath = [];
  const unchanged = [];

  for (const [skuKey, mapping] of skuToMapping) {
    const resolved = resolveTargetFields(tree, mapping.targetPath);
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
    });
  }

  let applied = 0;
  const failures = [];
  if (!dryRun) {
    for (const u of updates) {
      const { error } = await supabase
        .from(u.table)
        .update({ ...u.fields, updated_at: new Date().toISOString() })
        .eq('id', u.id);
      if (error) failures.push({ sku: u.sku, error: error.message });
      else applied += 1;
    }
    if (applied > 0 && existsSync(PENDING_FILE)) unlinkSync(PENDING_FILE);
  }

  const summary = {
    dryRun,
    totalSkus: skuToMapping.size,
    toUpdate: updates.length,
    applied,
    unchanged: unchanged.length,
    notFound: notFound.length,
    invalidPath: invalidPath.length,
    failures,
  };

  writeFileSync(join(ROOT, 'data/category-moves-report.json'), JSON.stringify(summary, null, 2));
  return summary;
}

export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  try {
    const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
    const summary = await applyCategoryMoves({ dryRun });
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('apply-category-moves:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Category move failed' });
  }
}
