import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { labelsToDbFields, loadTaxonomy, resolveLabelsForSubcategory, resolveLabelsFromPathIds } from './_taxonomy-utils.js';
import { parseExtraLabels } from '../lib/taxonomy-match.mjs';
import { deriveMotarroPathFromLabels, isMotarroProduct, motarroPathSnapshot } from './_mottaro-category.js';
import { restoreArchivedToLive } from './_ensure-product.js';
import { buildMoveTagPatch, tableHasMoveTagColumns } from './_move-tag.js';
import { detachSkuFromGroup } from './_group-cascade.js';
import { BULK_CHUNK_SIZE, MOVE_UPDATE_CHUNK_SIZE, runInChunks } from '../lib/bulk-chunk.mjs';

function sliceIntoChunks(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

/** Chunked `.update().in('sku', …)` — one failed chunk does not fail other chunks. */
async function chunkedInUpdate(supabase, table, skus, updatePayload) {
  if (!skus.length) return [];
  const chunks = sliceIntoChunks(skus, MOVE_UPDATE_CHUNK_SIZE);
  const chunkResults = await runInChunks(chunks, 1, async (skuChunk) => {
    const { error } = await supabase.from(table).update(updatePayload).in('sku', skuChunk);
    return skuChunk.map((sku) => (
      error ? { sku, ok: false, error: error.message } : { sku, ok: true }
    ));
  });
  return chunkResults.flat();
}

/** Chunked `.delete().in('sku', …)` — per-chunk failure isolation. */
async function chunkedInDelete(supabase, table, skus) {
  if (!skus.length) return { results: [], failedSkus: new Set() };
  const failedSkus = new Set();
  const results = [];
  const chunks = sliceIntoChunks(skus, MOVE_UPDATE_CHUNK_SIZE);
  const chunkResults = await runInChunks(chunks, 1, async (skuChunk) => {
    const { error } = await supabase.from(table).delete().in('sku', skuChunk);
    return skuChunk.map((sku) => {
      if (error) {
        failedSkus.add(sku);
        return { sku, ok: false, error: error.message };
      }
      return { sku, ok: true };
    });
  });
  for (const row of chunkResults.flat()) results.push(row);
  return { results, failedSkus };
}

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function resolveSkuTables(supabase, skus) {
  const liveSkus = new Map();
  const archSkus = new Map();
  const CHUNK = 200;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    const SELECT = 'sku,title,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four';
    const [{ data: live }, { data: arch }] = await Promise.all([
      supabase.from('website_stock').select(SELECT).in('sku', chunk),
      supabase.from('archived_products').select(SELECT).in('sku', chunk),
    ]);
    for (const row of live || []) liveSkus.set(row.sku, row);
    for (const row of arch || []) archSkus.set(row.sku, row);
  }
  return { liveSkus, archSkus };
}

async function archiveProduct(supabase, sku) {
  const { data: live } = await supabase.from('website_stock').select('sku').eq('sku', sku).maybeSingle();
  if (!live) return { sku, ok: false, error: 'Not in active catalogue' };
  const { error } = await supabase.rpc('archive_product', { p_sku: sku, p_by: 'admin-bulk' });
  if (error) return { sku, ok: false, error: error.message };
  return { sku, ok: true };
}

async function unarchiveProduct(supabase, sku) {
  try {
    const result = await restoreArchivedToLive(supabase, sku);
    const row = { sku, ok: true, alreadyLive: !!result.alreadyLive };
    // Restored but not synced to the storefront — carry the warnings so the
    // response can surface them instead of silently dropping the failure.
    if (result.syncWarnings?.length) row.syncWarnings = result.syncWarnings;
    return row;
  } catch (err) {
    return { sku, ok: false, error: err.message || 'Restore failed' };
  }
}

async function bulkMoveProducts(supabase, normalizedSkus, dbFields, { mottaroSnapshot = null, destinationLabel = '' } = {}) {
  const stamp = new Date().toISOString();
  const updatePayload = { ...dbFields, updated_at: stamp };
  // Mottaro rows also get their virtual position snapshotted so later
  // renames/deletes of the primary category can't shuffle the Mottaro tree.
  const mottaroPayload = mottaroSnapshot
    ? { ...updatePayload, mottaro_path: mottaroSnapshot }
    : updatePayload;
  const { liveSkus, archSkus } = await resolveSkuTables(supabase, normalizedSkus);
  const found = new Set([...liveSkus.keys(), ...archSkus.keys()]);
  const results = [];

  for (const [table, tableRows] of [['website_stock', liveSkus], ['archived_products', archSkus]]) {
    const list = normalizedSkus.filter((sku) => tableRows.has(sku));
    if (!list.length) continue;
    const mottaroSet = new Set(
      mottaroSnapshot ? list.filter((sku) => isMotarroProduct(tableRows.get(sku))) : [],
    );
    // 48h "moved" tag — batch skus by their current path so each group gets
    // the right moved_from label without per-row updates.
    const canTag = destinationLabel && await tableHasMoveTagColumns(supabase, table);
    const groups = new Map();
    for (const sku of list) {
      const base = mottaroSet.has(sku) ? mottaroPayload : updatePayload;
      const tag = canTag ? buildMoveTagPatch(tableRows.get(sku), destinationLabel, stamp) : null;
      const key = `${mottaroSet.has(sku) ? 'm' : 'p'}|${tag ? tag.moved_from : ''}`;
      if (!groups.has(key)) groups.set(key, { payload: tag ? { ...base, ...tag } : base, skus: [] });
      groups.get(key).skus.push(sku);
    }
    for (const { payload, skus: groupSkus } of groups.values()) {
      results.push(...await chunkedInUpdate(supabase, table, groupSkus, payload));
    }
  }

  for (const sku of normalizedSkus) {
    if (!found.has(sku)) results.push({ sku, ok: false, error: 'Not found' });
  }

  return results;
}

const REMOVE_SELECT = 'sku,title,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,subcategory_extra,mottaro_path';

async function fetchRowsForSkus(supabase, table, skus) {
  const map = new Map();
  const CHUNK = 200;
  for (let i = 0; i < skus.length; i += CHUNK) {
    const { data } = await supabase.from(table).select(REMOVE_SELECT).in('sku', skus.slice(i, i + CHUNK));
    for (const row of data || []) map.set(row.sku, row);
  }
  return map;
}

/**
 * Detach Mottaro products from their primary category. Mottaro membership is
 * derived from the product title, so clearing the primary category labels
 * simply removes the product from the normal browse tree while it stays
 * fully browsable under the virtual Mottaro tree. The current Mottaro
 * position is snapshotted to mottaro_path *before* the labels are cleared so
 * the brand-tree placement survives (otherwise the row would fall back to
 * Mottaro › Other › General on the next read).
 */
async function bulkRemoveFromCategory(supabase, normalizedSkus, tree) {
  // category / subcategory_one are NOT NULL in website_stock — empty string
  // is the codebase-wide "uncategorised" representation (see the
  // `category.eq.` filters and `!row.category` checks).
  const clearPatch = {
    category: '',
    subcategory_one: '',
    subcategory_two: null,
    subcategory_three: null,
    subcategory_four: null,
    subcategory_extra: null,
  };
  const results = [];
  const stamp = new Date().toISOString();

  for (const table of ['website_stock', 'archived_products']) {
    const rows = await fetchRowsForSkus(supabase, table, normalizedSkus);
    // Group SKUs by the mottaro_path value we need to write so each snapshot
    // group is a single chunked UPDATE. '__none__' = leave mottaro_path as-is.
    const groups = new Map();
    for (const [sku, row] of rows) {
      if (!isMotarroProduct(row)) {
        results.push({ sku, ok: false, error: 'Not a Motarro product' });
        continue;
      }
      const labels = [row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four, ...parseExtraLabels(row.subcategory_extra)];
      const snapshot = motarroPathSnapshot(deriveMotarroPathFromLabels(labels, tree));
      const key = snapshot && snapshot !== row.mottaro_path ? snapshot : '__none__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sku);
    }
    for (const [key, skus] of groups) {
      const patch = key === '__none__'
        ? { ...clearPatch, updated_at: stamp }
        : { ...clearPatch, mottaro_path: key, updated_at: stamp };
      results.push(...await chunkedInUpdate(supabase, table, skus, patch));
    }
  }

  const handled = new Set(results.map((r) => r.sku));
  for (const sku of normalizedSkus) {
    if (!handled.has(sku)) results.push({ sku, ok: false, error: 'Not found' });
  }
  return results;
}

async function bulkDeleteProducts(supabase, normalizedSkus) {
  const { liveSkus, archSkus } = await resolveSkuTables(supabase, normalizedSkus);
  const found = new Set([...liveSkus.keys(), ...archSkus.keys()]);
  const failedSkus = new Set();
  const errorBySku = new Map();

  const liveList = normalizedSkus.filter((sku) => liveSkus.has(sku));
  const archList = normalizedSkus.filter((sku) => archSkus.has(sku));

  // A SKU can live in BOTH tables; the per-table outcomes only feed the
  // failure set + error detail here. The final results are built ONCE below,
  // one row per unique SKU — otherwise a deleted product was counted twice
  // (3× when present in both tables), inflating the reported `deleted` total.
  const collect = (outcome) => {
    for (const sku of outcome.failedSkus) failedSkus.add(sku);
    for (const r of outcome.results) if (!r.ok && !errorBySku.has(r.sku)) errorBySku.set(r.sku, r.error);
  };
  if (liveList.length) collect(await chunkedInDelete(supabase, 'website_stock', liveList));
  if (archList.length) collect(await chunkedInDelete(supabase, 'archived_products', archList));

  if (normalizedSkus.length) {
    const previewChunks = sliceIntoChunks(normalizedSkus, MOVE_UPDATE_CHUNK_SIZE);
    for (const chunk of previewChunks) {
      await supabase.from('staged_product_previews').delete().in('sku', chunk).catch(() => {});
    }
  }

  const results = [];
  for (const sku of normalizedSkus) {
    if (!found.has(sku)) results.push({ sku, ok: false, error: 'Not found' });
    else if (failedSkus.has(sku)) results.push({ sku, ok: false, error: errorBySku.get(sku) || 'Delete failed' });
    else results.push({ sku, ok: true });
  }
  return results;
}

async function recycleLiveProduct(supabase, sku) {
  const { data: live } = await supabase.from('website_stock').select('sku').eq('sku', sku).maybeSingle();
  if (!live) return { sku, ok: false, error: 'Not in active catalogue' };
  const { error } = await supabase.rpc('archive_product', { p_sku: sku, p_by: 'recycle-bin' });
  if (error) return { sku, ok: false, error: error.message };
  // Same group hygiene as the single-item path: an archived SKU must not stay
  // the face of a live variant group.
  await detachSkuFromGroup(supabase, sku).catch(() => {});
  return { sku, ok: true };
}

async function bulkArchiveOrUnarchive(supabase, normalizedSkus, action) {
  const fn = action === 'archive' ? archiveProduct : unarchiveProduct;
  const chunked = await runInChunks(normalizedSkus, BULK_CHUNK_SIZE, (sku) => fn(supabase, sku));
  return chunked.map((row) => {
    if (row.error && !row.sku) return { sku: row.item, ok: false, error: row.error };
    return row;
  });
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { action, skus, categoryId, subcategoryId, categoryPathIds } = req.body || {};
  const normalizedSkus = [...new Set((skus || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!normalizedSkus.length) return res.status(400).json({ error: 'No products selected' });

  const supabase = getStockClient();

  try {
    if (action === 'move') {
      if (!categoryId && !(Array.isArray(categoryPathIds) && categoryPathIds.length)) {
        return res.status(400).json({ error: 'Destination category is required' });
      }
      const tree = await loadTaxonomy();
      let labels;
      try {
        if (Array.isArray(categoryPathIds) && categoryPathIds.length >= 2) {
          labels = resolveLabelsFromPathIds(tree, categoryPathIds);
        } else {
          if (!categoryId) return res.status(400).json({ error: 'Main category is required' });
          if (!subcategoryId) return res.status(400).json({ error: 'Choose a subcategory destination' });
          labels = resolveLabelsForSubcategory(tree, categoryId, subcategoryId);
        }
      } catch (err) {
        // The taxonomy tree changed between the admin opening the modal and
        // clicking Confirm — return 409 so the client can reload categories
        // and re-select the destination instead of writing to a stale path.
        return res.status(409).json({
          error: 'Destination category changed — reload categories and reselect.',
          detail: err.message || 'Invalid category path',
        });
      }
      if (labels.length < 2) {
        return res.status(400).json({ error: 'Choose a main category and at least one subcategory' });
      }
      const dbFields = labelsToDbFields(labels);
      const destinationPath = labels.join(' › ');
      const mottaroSnapshot = motarroPathSnapshot(deriveMotarroPathFromLabels(labels, tree));
      const results = await bulkMoveProducts(supabase, normalizedSkus, dbFields, { mottaroSnapshot, destinationLabel: destinationPath });
      const failed = results.filter((r) => !r.ok);
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        moved: results.filter((r) => r.ok).length,
        failed,
        destinationPath,
        destinationLabels: labels,
      });
    }

    if (action === 'removeFromCategory') {
      const tree = await loadTaxonomy();
      const results = await bulkRemoveFromCategory(supabase, normalizedSkus, tree);
      const failed = results.filter((r) => !r.ok);
      const nonMottaro = failed.filter((r) => r.error === 'Not a Motarro product').length;
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        removed: results.filter((r) => r.ok).length,
        failed,
        nonMottaro,
      });
    }

    if (action === 'archive') {
      const results = await bulkArchiveOrUnarchive(supabase, normalizedSkus, 'archive');
      const failed = results.filter((r) => !r.ok);
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        archived: results.filter((r) => r.ok).length,
        failed,
      });
    }

    if (action === 'delete') {
      const results = await bulkDeleteProducts(supabase, normalizedSkus);
      const failed = results.filter((r) => !r.ok);
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        deleted: results.filter((r) => r.ok).length,
        failed,
      });
    }

    if (action === 'recycle') {
      // Live -> recycle bin. One request for the whole selection: the old UI
      // looped one request per SKU and invalidated the catalogue cache after
      // each, which is what produced the bulk-action error storms.
      const results = await runInChunks(normalizedSkus, BULK_CHUNK_SIZE, (sku) => recycleLiveProduct(supabase, sku));
      const rows = results.map((r) => (r.error && !r.sku ? { sku: r.item, ok: false, error: r.error } : r));
      const failed = rows.filter((r) => !r.ok);
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        recycled: rows.filter((r) => r.ok).length,
        failed,
      });
    }

    if (action === 'recycleFromArchive') {
      // Archived -> recycle bin is just a re-tag; do it as one UPDATE per chunk
      // instead of a round-trip per SKU.
      const failed = [];
      let recycled = 0;
      for (let i = 0; i < normalizedSkus.length; i += MOVE_UPDATE_CHUNK_SIZE) {
        const chunk = normalizedSkus.slice(i, i + MOVE_UPDATE_CHUNK_SIZE);
        const { data, error } = await supabase
          .from('archived_products')
          .update({ archived_by: 'recycle-bin', archived_at: new Date().toISOString() })
          .in('sku', chunk)
          .select('sku');
        if (error) {
          failed.push(...chunk.map((sku) => ({ sku, ok: false, error: error.message })));
          continue;
        }
        const updated = new Set((data || []).map((r) => r.sku));
        recycled += updated.size;
        failed.push(...chunk.filter((sku) => !updated.has(sku)).map((sku) => ({ sku, ok: false, error: 'Not in archive' })));
      }
      return res.status(failed.length ? 207 : 200).json({ ok: failed.length === 0, recycled, failed });
    }

    if (action === 'unarchive') {
      const results = await bulkArchiveOrUnarchive(supabase, normalizedSkus, 'unarchive');
      const failed = results.filter((r) => !r.ok);
      // "sku: rpc: message" per failed sync step — restored rows that missed a
      // storefront sync RPC may not appear on the site until the next sync.
      const syncWarnings = results.flatMap((r) => (r.syncWarnings || []).map((w) => `${r.sku}: ${w}`));
      return res.status(failed.length ? 207 : 200).json({
        ok: failed.length === 0,
        restored: results.filter((r) => r.ok).length,
        failed,
        syncWarnings,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Bulk operation failed' });
  }
}
