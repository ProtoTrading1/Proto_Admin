#!/usr/bin/env node
/**
 * One-off backfill: persist mottaro_path for existing Mottaro products.
 *
 * Snapshots each Mottaro row's current derived virtual position (from its
 * primary category labels) into the mottaro_path column, so behaviour does
 * not regress when the read logic starts consulting the stored path.
 * Only meaningful positions are written — the bare root and the
 * Other›General fallback are never snapshotted. Existing snapshots are
 * left alone unless --force is passed.
 *
 * Requires migration 038 (mottaro_path columns) to be applied first.
 *
 * Usage:
 *   VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... \
 *   VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/backfill-mottaro-path.mjs [--dry-run] [--force]
 *
 * (The portal pair is optional — without it the bundled taxonomy is used.)
 */

import { createClient } from '@supabase/supabase-js';
import {
  deriveMotarroPathFromLabels,
  isMotarroProduct,
  motarroPathSnapshot,
} from '../lib/mottaro-category.mjs';
import { loadTaxonomy } from '../api/_taxonomy-utils.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const url = process.env.STOCK_SUPABASE_URL || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY || process.env.VITE_STOCK_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing stock Supabase env vars (VITE_STOCK_SUPABASE_URL / VITE_STOCK_SUPABASE_KEY)');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function loadTree() {
  // loadTaxonomy reads the stored tree from the portal site-config bucket
  // (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) and falls back to the
  // bundled tree; either way the Mottaro branch is injected.
  return loadTaxonomy({ bypassCache: true });
}

const SELECT_COLS = 'sku,title,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,mottaro_path';

async function fetchAll(table) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(SELECT_COLS).range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function backfillTable(table, tree) {
  const rows = await fetchAll(table);
  const mottaroRows = rows.filter(isMotarroProduct);
  let written = 0;
  let skippedExisting = 0;
  let skippedNoPosition = 0;

  for (const row of mottaroRows) {
    if (row.mottaro_path && !FORCE) {
      skippedExisting += 1;
      continue;
    }
    const labels = [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four];
    const snapshot = motarroPathSnapshot(deriveMotarroPathFromLabels(labels, tree));
    if (!snapshot || snapshot === row.mottaro_path) {
      skippedNoPosition += 1;
      continue;
    }
    if (!DRY_RUN) {
      const { error } = await sb.from(table).update({ mottaro_path: snapshot }).eq('sku', row.sku);
      if (error) {
        console.error(`  ${table} ${row.sku}: ${error.message}`);
        continue;
      }
    }
    written += 1;
  }

  console.log(`${table}: ${mottaroRows.length} Mottaro rows — ${written} snapshotted${DRY_RUN ? ' (dry run)' : ''}, ${skippedExisting} already set, ${skippedNoPosition} no meaningful position`);
}

const tree = await loadTree();
await backfillTable('website_stock', tree);
await backfillTable('archived_products', tree);
console.log('Done.');
