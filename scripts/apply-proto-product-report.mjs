#!/usr/bin/env node
/**
 * Apply Proto Product Report (SKU, Name, In Stock, Images).
 *
 * • In Stock = No  + live on site → archive
 * • In Stock = Yes + archived     → restore to live
 * • Not on site (not duplicate SKU) → insert with categories + Supabase SOH/price
 * • Live on site                  → sync price/SOH from public.products
 *
 * Excel "In Stock" only drives archive/restore — not whether missing SKUs are added.
 * Barcode for ERP lookup is taken from the product name (…barcode…) at the end.
 * Stock and pricing always come from public.products (Supabase), never the spreadsheet.
 *
 * Usage:
 *   node scripts/apply-proto-product-report.mjs data/proto-product-report.xlsx
 *   node scripts/apply-proto-product-report.mjs data/proto-product-report.xlsx --apply
 *   node scripts/apply-proto-product-report.mjs data/proto-product-report.xlsx --apply --missing-only
 */

import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { existsSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { restoreArchivedToLive } from '../api/_ensure-product.js';
import { findProductBySku, fetchProductLookupMap } from '../api/_sku-match.js';
import { loadBundledTaxonomy, resolvePathFields } from './lib/taxonomy-paths.mjs';
import { inferCategoryPathFromName, categoryFieldsFromLiveRow } from './lib/product-name-category.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DEFAULT_FILE = join(ROOT, 'data/proto-product-report.xlsx');
const PARALLEL = 30;

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const MISSING_ONLY = args.has('--missing-only');
const fileArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const filePath = fileArg || DEFAULT_FILE;

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tree = loadBundledTaxonomy();

function normSku(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getUTCMonth() + 1}-${v.getUTCFullYear()}`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  const s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
  return s;
}

function parseInStock(val) {
  const v = String(val ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'y') return true;
  if (v === 'no' || v === 'n') return false;
  return null;
}

/** Barcode is in the product description/name, usually in parentheses at the end. */
export function extractBarcodeFromName(name) {
  const m = String(name || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : '';
}

function imageUrls(row) {
  return ['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5', 'Image 6']
    .map((k) => String(row[k] || '').trim())
    .filter(Boolean);
}

function productPath(row) {
  return [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four]
    .filter(Boolean)
    .join(' > ');
}

async function loadCatalogueMaps() {
  const liveBySku = new Map();
  const liveByBarcode = new Map();
  const archivedBySku = new Map();

  for (const table of ['website_stock', 'archived_products']) {
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select('id, sku, barcode, title, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four, price, stock_qty, available_stock, image_url_one, image_url_two, image_url_three, image_url_four')
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data || []) {
        const k = normSku(row.sku).toUpperCase();
        if (!k) continue;
        if (table === 'website_stock') {
          liveBySku.set(k, row);
          const bc = String(row.barcode || '').trim().toUpperCase();
          if (bc && !liveByBarcode.has(bc)) liveByBarcode.set(bc, row);
        } else {
          archivedBySku.set(k, row);
        }
      }
      if (!data?.length || data.length < 1000) break;
      from += 1000;
    }
  }

  return { liveBySku, liveByBarcode, archivedBySku };
}

function resolveErpProduct(lookupMap, sku, barcode) {
  const direct = findProductBySku(lookupMap, sku) || (barcode ? findProductBySku(lookupMap, barcode) : null);
  if (direct) return direct;
  if (barcode && /[A-Za-z]$/.test(barcode)) {
    return findProductBySku(lookupMap, barcode.slice(0, -1));
  }
  return null;
}

function buildCategoryFields(name, sku, erpDescription = '', liveByBarcode, erp) {
  const path = inferCategoryPathFromName(name, sku, erpDescription);
  if (path) {
    const fields = resolvePathFields(tree, path);
    if (fields) return { fields, source: 'name' };
  }

  const erpKey = String(erp?.sku || '').trim().toUpperCase();
  const nameBarcode = extractBarcodeFromName(name).toUpperCase();
  for (const key of [erpKey, nameBarcode]) {
    if (!key) continue;
    const sibling = liveByBarcode?.get(key);
    const fields = categoryFieldsFromLiveRow(sibling);
    if (fields) return { fields, source: 'sibling_barcode' };
  }

  return null;
}

function needsStockSync(live, erp) {
  if (!erp) return false;
  const price = Number(erp.sell_price);
  const erpPrice = Number.isFinite(price) && price > 0 ? price : null;
  const livePrice = Number(live.price);
  const liveStock = Number(live.stock_qty ?? live.available_stock ?? 0);
  const erpStock = Number(erp.stock_qty ?? erp.available_stock ?? 0);
  if (erpPrice != null && livePrice !== erpPrice) return true;
  if (liveStock !== erpStock) return true;
  if (Number(live.available_stock ?? 0) !== Number(erp.available_stock ?? erpStock)) return true;
  return false;
}

function stockPatchFromErp(product) {
  const price = Number(product.sell_price);
  return {
    stock_qty: product.stock_qty ?? 0,
    available_stock: product.available_stock ?? product.stock_qty ?? 0,
    ...(Number.isFinite(price) && price > 0 ? { price } : {}),
    updated_at: new Date().toISOString(),
  };
}

async function runParallel(items, fn) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(fn));
  }
}

async function main() {
  const wb = XLSX.readFile(filePath, { cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  console.log(`Loaded ${rows.length} rows from ${filePath}\n`);

  const { liveBySku, liveByBarcode, archivedBySku } = await loadCatalogueMaps();
  console.log(`Catalogue: ${liveBySku.size} live SKUs${MISSING_ONLY ? ' (missing-only mode)' : ''}\n`);

  const report = [];
  const erpKeys = new Set();

  for (const row of rows) {
    const sku = normSku(row.SKU);
    const name = String(row.Name || row.name || '').trim();
    const inStock = parseInStock(row['In Stock'] ?? row['In stock']);
    if (inStock === null) continue;
    if (!sku) {
      report.push({ action: 'skip', reason: 'missing_sku', name });
      continue;
    }
    const barcode = extractBarcodeFromName(name);
    erpKeys.add(sku);
    if (barcode) erpKeys.add(barcode);
    report.push({ sku, name, inStock, barcode, images: imageUrls(row) });
  }

  const lookupMap = await fetchProductLookupMap(
    sb,
    [...erpKeys],
    'sku, description, sell_price, stock_qty, available_stock, units_of_issue',
  );

  const stats = {
    archive: 0,
    restore: 0,
    syncLive: 0,
    categorize: 0,
    insert: 0,
    skipArchived: 0,
    skipNoCategory: 0,
    skipMissingSku: 0,
    skipUnchanged: 0,
    categorizeFromSibling: 0,
    errors: 0,
  };
  const log = [];

  const toArchive = [];
  const toRestore = [];
  const toSync = [];
  const toInsert = [];

  for (const item of report) {
    if (item.action === 'skip') {
      stats.skipMissingSku++;
      continue;
    }

    const skuKey = item.sku.toUpperCase();
    const live = liveBySku.get(skuKey);
    const archived = archivedBySku.get(skuKey);
    const erp = resolveErpProduct(lookupMap, item.sku, item.barcode);

    if (live) {
      if (!item.inStock) {
        if (!MISSING_ONLY) toArchive.push(item);
        continue;
      }
      if (!MISSING_ONLY) toSync.push({ item, live, erp });
      continue;
    }

    if (archived) {
      if (item.inStock) toRestore.push(item);
      else stats.skipArchived++;
      continue;
    }

    const cat = buildCategoryFields(item.name, item.sku, erp?.description || '', liveByBarcode, erp);
    if (!cat) {
      stats.skipNoCategory++;
      log.push({ sku: item.sku, action: 'skip_no_category', name: item.name.slice(0, 60) });
      continue;
    }
    if (cat.source === 'sibling_barcode') stats.categorizeFromSibling++;

    toInsert.push({ item, erp, catFields: cat.fields });
  }

  if (APPLY) {
    await runParallel(toArchive, async (item) => {
      const { error } = await sb.rpc('archive_product', { p_sku: item.sku, p_by: 'proto-report' });
      if (error) {
        stats.errors++;
        log.push({ sku: item.sku, action: 'archive', error: error.message });
      } else {
        stats.archive++;
        log.push({ sku: item.sku, action: 'archived' });
      }
    });

    await runParallel(toRestore, async (item) => {
      try {
        await restoreArchivedToLive(sb, item.sku);
        stats.restore++;
        log.push({ sku: item.sku, action: 'restored' });
      } catch (err) {
        stats.errors++;
        log.push({ sku: item.sku, action: 'restore', error: err.message });
      }
    });

    await runParallel(toSync, async ({ item, live, erp }) => {
      const patch = {};
      let needsCat = false;
      const cat = buildCategoryFields(item.name, item.sku, erp?.description || '', liveByBarcode, erp);

      if (erp && needsStockSync(live, erp)) {
        Object.assign(patch, stockPatchFromErp(erp));
      }

      if (cat && (
        live.category !== cat.fields.category
        || (live.subcategory_one || null) !== (cat.fields.subcategory_one || null)
        || (live.subcategory_two || null) !== (cat.fields.subcategory_two || null)
        || (live.subcategory_three || null) !== (cat.fields.subcategory_three || null)
      )) {
        if (!live.subcategory_two || live.subcategory_one === live.category) {
          Object.assign(patch, cat.fields);
          needsCat = true;
        }
      }

      if (!Object.keys(patch).length) {
        stats.skipUnchanged++;
        return;
      }
      patch.updated_at = new Date().toISOString();

      const { error } = await sb.from('website_stock').update(patch).eq('sku', item.sku);
      if (error) {
        stats.errors++;
        log.push({ sku: item.sku, action: 'sync', error: error.message });
      } else {
        stats.syncLive++;
        if (needsCat) stats.categorize++;
        log.push({ sku: item.sku, action: needsCat ? 'synced+categorized' : 'synced' });
      }
    });

    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100);
      const insertRows = chunk.map(({ item, erp, catFields }) => {
        const imgs = item.images;
        return {
          sku: item.sku,
          barcode: erp?.sku || item.barcode || item.sku,
          title: item.name || erp?.description || item.sku,
          original_description: item.name || erp?.description || item.sku,
          ...catFields,
          ...(erp ? stockPatchFromErp(erp) : { stock_qty: 0, available_stock: 0 }),
          image_url_one: imgs[0] || null,
          image_url_two: imgs[1] || null,
          image_url_three: imgs[2] || null,
          image_url_four: imgs[3] || null,
        };
      });

      const { error } = await sb.from('website_stock').insert(insertRows);
      if (error) {
        for (const { item, catFields } of chunk) {
          const row = insertRows.find((r) => r.sku === item.sku);
          const { error: oneErr } = await sb.from('website_stock').insert(row);
          if (oneErr) {
            stats.errors++;
            log.push({ sku: item.sku, action: 'insert', error: oneErr.message });
          } else {
            stats.insert++;
            log.push({ sku: item.sku, action: 'inserted', path: Object.values(catFields).filter(Boolean).join(' > ') });
            await sb.rpc('upsert_website_product_from_stock', { p_website_sku: item.sku });
          }
        }
      } else {
        stats.insert += chunk.length;
        for (const { item, catFields } of chunk) {
          log.push({ sku: item.sku, action: 'inserted', path: Object.values(catFields).filter(Boolean).join(' > ') });
        }
        await runParallel(chunk, async ({ item }) => {
          await sb.rpc('upsert_website_product_from_stock', { p_website_sku: item.sku });
        });
      }
      if ((i + 100) % 500 === 0 || i + 100 >= toInsert.length) {
        console.log(`Insert progress: ${Math.min(i + 100, toInsert.length)}/${toInsert.length}`);
      }
    }

    const { error } = await sb.rpc('sync_website_from_products');
    if (error) console.warn('sync_website_from_products:', error.message);
  } else {
    stats.archive = toArchive.length;
    stats.restore = toRestore.length;
    stats.syncLive = toSync.length;
    stats.insert = toInsert.length;
    stats.categorize = toSync.filter(({ live, item, erp }) => {
      const cat = buildCategoryFields(item.name, item.sku, erp?.description || '', liveByBarcode, erp);
      return cat && (!live.subcategory_two || live.subcategory_one === live.category);
    }).length;
    for (const item of toArchive) log.push({ sku: item.sku, action: 'would_archive' });
    for (const item of toRestore) log.push({ sku: item.sku, action: 'would_restore' });
    for (const { item, catFields } of toInsert) {
      log.push({ sku: item.sku, action: 'would_insert', path: Object.values(catFields).filter(Boolean).join(' > ') });
    }
  }

  console.log('Summary:', stats);
  const reportPath = join(ROOT, 'data/proto-product-report-apply-log.csv');
  const lines = ['sku,action,detail', ...log.map((l) => `${JSON.stringify(l.sku || '')},${l.action},${JSON.stringify(l.error || l.path || l.from || l.name || '')}`)];
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`Log: ${reportPath}`);

  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to commit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
