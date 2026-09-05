import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { resolveProductLoaderMatch } from './_product-loader-lookup.js';
import { ensureProductFromCatalogueRow } from './_ensure-product.js';
import { labelsToDbFields, loadTaxonomy, resolveLabelsFromPathIds } from './_taxonomy-utils.js';
import { parseExtraLabels } from '../lib/taxonomy-match.mjs';
import { deriveMotarroPathFromLabels, isMotarroProduct, motarroPathSnapshot } from './_mottaro-category.js';
import { buildMoveTagPatch, tableHasMoveTagColumns } from './_move-tag.js';
import { normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';

const CATEGORY_COLS = ['category', 'subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four'];

/**
 * Snapshot the row's virtual Mottaro position after a category/title change.
 * Best effort — the primary update already succeeded.
 */
async function snapshotMottaroPath(supabase, table, verified) {
  if (!isMotarroProduct(verified)) return;
  const tree = await loadTaxonomy();
  // Include depth beyond subcategory_four so a deep Motarro product snapshots to
  // its true position rather than a truncated one.
  const labels = [...CATEGORY_COLS.map((col) => verified[col]), ...parseExtraLabels(verified.subcategory_extra)];
  const snapshot = motarroPathSnapshot(deriveMotarroPathFromLabels(labels, tree));
  if (!snapshot || snapshot === verified.mottaro_path) return;
  const { error } = await supabase
    .from(table)
    .update({ mottaro_path: snapshot })
    .eq('sku', verified.sku);
  if (!error) verified.mottaro_path = snapshot;
}

function getStockAdminClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const {
    websiteSku,
    expectedUpdatedAt,
    image,
    description,
    packDescription,
    unitsOfIssue,
    minQty,
    title,
    name,
    price,
    category,
    subcategory_one,
    subcategory_two,
    subcategory_three,
    subcategory_four,
    barcode,
    code,
    newWebsiteSku,
  } = req.body || {};
  if (!websiteSku) return res.status(400).json({ error: 'websiteSku is required' });

  const sku = String(websiteSku).trim();
  const nextSku = newWebsiteSku ? String(newWebsiteSku).trim() : '';
  const patch = {};
  if (image !== undefined) {
    const images = String(image).split(',').map((url) => url.trim()).filter(Boolean);
    patch.image_url_one = images[0] || null;
    patch.image_url_two = images[1] || null;
    patch.image_url_three = images[2] || null;
    patch.image_url_four = images[3] || null;
  }
  if (barcode !== undefined) patch.barcode = String(barcode).trim();
  if (code !== undefined) patch.barcode = String(code).trim();
  if (description !== undefined) patch.original_description = String(description).trim();
  if (packDescription !== undefined) patch.pack_description = String(packDescription).trim();
  if (unitsOfIssue !== undefined) patch.units_of_issue = normalizeUnitsOfIssue(unitsOfIssue);
  if (minQty !== undefined) {
    const parsedMinQty = Number(minQty);
    if (!Number.isSafeInteger(parsedMinQty) || parsedMinQty < 1 || parsedMinQty > 9999) {
      return res.status(400).json({ error: 'Minimum order quantity must be a whole number from 1 to 9,999' });
    }
    patch.min_order_qty = parsedMinQty;
  }
  if (title !== undefined) patch.title = String(title).trim();
  if (name !== undefined) patch.title = String(name).trim();
  if (price !== undefined) patch.price = Number(price) || 0;
  if (category !== undefined) patch.category = String(category).trim();
  if (subcategory_one !== undefined) patch.subcategory_one = String(subcategory_one).trim();
  if (subcategory_two !== undefined) patch.subcategory_two = subcategory_two ? String(subcategory_two).trim() : null;
  if (subcategory_three !== undefined) patch.subcategory_three = subcategory_three ? String(subcategory_three).trim() : null;
  if (subcategory_four !== undefined) patch.subcategory_four = subcategory_four ? String(subcategory_four).trim() : null;
  // subcategory_extra holds depth beyond subcategory_four (JSON array of labels).
  // A raw-fields write that names columns up to subcategory_four defines a path
  // within the fixed columns, so any stale deeper tail must be cleared — else a
  // move to a shallower category would leave the row pointing past its new leaf.
  const rawExtra = req.body?.subcategory_extra;
  if (rawExtra !== undefined) {
    patch.subcategory_extra = rawExtra && String(rawExtra).trim() ? String(rawExtra).trim() : null;
  } else if (CATEGORY_COLS.some((col) => patch[col] !== undefined)) {
    patch.subcategory_extra = null;
  }
  // Preferred category input: taxonomy node ids, resolved server-side against
  // the live tree (mirrors bulk move) so a stale client can't write outdated
  // labels. Raw label fields above remain supported for legacy callers.
  const categoryPathIds = req.body?.categoryPathIds;
  if (Array.isArray(categoryPathIds) && categoryPathIds.length) {
    try {
      const tree = await loadTaxonomy();
      const labels = resolveLabelsFromPathIds(tree, categoryPathIds);
      Object.assign(patch, labelsToDbFields(labels));
    } catch (err) {
      return res.status(409).json({
        error: 'Destination category changed — reload categories and reselect.',
        detail: err.message || 'Invalid category path',
      });
    }
  }
  if (nextSku && nextSku !== sku) patch.sku = nextSku;
  if (!Object.keys(patch).length) return res.status(200).json({ ok: true });

  patch.updated_at = new Date().toISOString();
  const supabase = getStockAdminClient();

  const LOOKUP_CATEGORY_COLS = 'category, subcategory_one, subcategory_two, subcategory_three, subcategory_four';
  let table = 'website_stock';
  let { data: product, error: lookupError } = await supabase
    .from('website_stock')
    .select(`sku, barcode, updated_at, ${LOOKUP_CATEGORY_COLS}`)
    .eq('sku', sku)
    .maybeSingle();

  if (lookupError) return res.status(400).json({ error: lookupError.message });
  if (product) product.archived_by = null;

  if (!product) {
    const archived = await supabase
      .from('archived_products')
      .select(`sku, barcode, archived_by, updated_at, ${LOOKUP_CATEGORY_COLS}`)
      .eq('sku', sku)
      .maybeSingle();
    if (archived.error) return res.status(400).json({ error: archived.error.message });
    if (!archived.data) return res.status(404).json({ error: 'Product not found' });
    product = archived.data;
    table = 'archived_products';
  }

  if (expectedUpdatedAt && product.updated_at && product.updated_at !== expectedUpdatedAt) {
    return res.status(409).json({
      error: 'This product was changed by someone else — reload to see the latest.',
      currentUpdatedAt: product.updated_at,
    });
  }

  if (nextSku && nextSku !== sku) {
    for (const tbl of ['website_stock', 'archived_products']) {
      const { data: clash } = await supabase.from(tbl).select('sku').eq('sku', nextSku).maybeSingle();
      if (clash) return res.status(409).json({ error: `SKU "${nextSku}" already exists` });
    }
  }

  // 48h "moved" tag: when the category labels change, stamp where the
  // product came from and where it went (skipped until migration 039 runs).
  if (CATEGORY_COLS.some((col) => patch[col] !== undefined)
    && await tableHasMoveTagColumns(supabase, table)) {
    // Levels absent from the patch keep their current value; an explicit
    // null in the patch means that level was cleared.
    const destination = CATEGORY_COLS
      .map((col) => (patch[col] !== undefined ? patch[col] : product[col]))
      .filter(Boolean)
      .join(' › ');
    const tag = buildMoveTagPatch(product, destination, patch.updated_at);
    if (tag) Object.assign(patch, tag);
  }

  const lookupSku = sku;
  const { error } = await supabase.from(table).update(patch).eq('sku', lookupSku);
  if (error) return res.status(400).json({ error: error.message });

  const verifySku = patch.sku || sku;
  const { data: verified, error: verifyError } = await supabase
    .from(table)
    .select('*')
    .eq('sku', verifySku)
    .maybeSingle();
  if (verifyError) return res.status(400).json({ error: verifyError.message });
  if (!verified) return res.status(500).json({ error: 'Update did not persist — product not found after save' });

  const touchedMottaroInputs = CATEGORY_COLS.some((col) => patch[col] !== undefined) || patch.title !== undefined;
  if (touchedMottaroInputs) {
    try {
      await snapshotMottaroPath(supabase, table, verified);
    } catch { /* non-fatal — snapshot refresh is best effort */ }
  }

  // Archived placeholders often have no ERP data yet. When the admin fixes the
  // SKU or barcode on such a row, re-run the ERP/Positill lookup so the row can
  // attach live description / stock / price. Runs for nutstore placeholders and
  // for ANY archived row that currently has no price and no stock (the
  // "Needs SOH/price" rows the admin is correcting) — a Positill match only
  // overwrites when found, so rows that already carry good data are untouched.
  let relink = null;
  const changedIdentifier = patch.sku != null || patch.barcode != null;
  const lacksErpData = (Number(verified.price) || 0) === 0
    && (Number(verified.stock_qty) || 0) === 0
    && (Number(verified.available_stock) || 0) === 0;
  // If the admin typed a name/description in THIS save, the ERP relink must not
  // overwrite it with the Positill title — it still pulls stock/price.
  const adminSetName = patch.title !== undefined || patch.original_description !== undefined;
  if (
    changedIdentifier
    && table === 'archived_products'
    && (verified.archived_by === 'nutstore' || lacksErpData)
  ) {
    try {
      const identifier = verified.barcode || verified.sku;
      const match = await resolveProductLoaderMatch(supabase, {
        code: identifier,
        displayCode: identifier,
        imageSlot: 1,
      });
      if (match?.sqlRow) {
        await ensureProductFromCatalogueRow(supabase, {
          ...verified,
          barcode: verified.barcode || verified.sku,
          sell_price: match.sqlRow.price,
          stock_qty: match.sqlRow.onhand,
          available_stock: match.sqlRow.available,
          original_description: verified.original_description || match.sqlRow.title,
        });
        const relinkPatch = {
          updated_at: new Date().toISOString(),
          price: Number(match.sqlRow.price) || 0,
          stock_qty: Number(match.sqlRow.onhand) || 0,
          available_stock: Number.isFinite(Number(match.sqlRow.available))
            ? Number(match.sqlRow.available)
            : (Number(match.sqlRow.onhand) || 0),
        };
        const matchedTitle = String(match.sqlRow.title || '').trim();
        if (matchedTitle && !adminSetName) {
          relinkPatch.original_description = matchedTitle;
          relinkPatch.title = matchedTitle;
        }
        const { error: relinkErr } = await supabase
          .from('archived_products')
          .update(relinkPatch)
          .eq('sku', verifySku);
        if (relinkErr) throw relinkErr;
        const { data: refreshed } = await supabase
          .from('archived_products')
          .select('*')
          .eq('sku', verifySku)
          .maybeSingle();
        if (refreshed) Object.assign(verified, refreshed);
        relink = {
          matched: true,
          matchedBy: match.matchedBy,
          stock: match.sqlRow.available,
          price: match.sqlRow.price,
        };
      } else if (match?.websiteRow) {
        const relinkPatch = {
          updated_at: new Date().toISOString(),
          price: Number(match.websiteRow.price) || 0,
        };
        if (match.websiteRow.stock_qty != null) relinkPatch.stock_qty = Number(match.websiteRow.stock_qty);
        if (match.websiteRow.available_stock != null) {
          relinkPatch.available_stock = Number(match.websiteRow.available_stock);
        }
        const matchedTitle = String(
          match.websiteRow.original_description || match.websiteRow.title || '',
        ).trim();
        if (matchedTitle && !adminSetName) {
          relinkPatch.original_description = matchedTitle;
          relinkPatch.title = matchedTitle;
        }
        const { error: relinkErr } = await supabase
          .from('archived_products')
          .update(relinkPatch)
          .eq('sku', verifySku);
        if (relinkErr) throw relinkErr;
        const { data: refreshed } = await supabase
          .from('archived_products')
          .select('*')
          .eq('sku', verifySku)
          .maybeSingle();
        if (refreshed) Object.assign(verified, refreshed);
        relink = { matched: true, matchedBy: match.matchedBy };
      } else {
        relink = { matched: false };
      }
    } catch (err) {
      // Non-fatal — the row is updated even if relink fails.
      relink = { matched: false, error: err.message || 'relink failed' };
    }
  }

  return res.status(200).json({ ok: true, product: verified, relink });
}
