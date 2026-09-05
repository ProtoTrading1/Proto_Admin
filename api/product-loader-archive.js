import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';
import { NUTSTORE_ARCHIVED_BY } from './nutstore-process.js';
import { normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';

const ARCHIVE_DEFAULT_CATEGORY = 'Uncategorised';
const ARCHIVE_DEFAULT_SUB = 'General';

// bashews.jpg -> slot 1, bashews.2.jpg -> slot 2, and so on. parseLoaderFilename
// already derives the slot; this maps it to the column it must land in.
const SLOT_COLUMNS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

function slotColumn(rawSlot) {
  const slot = Number(rawSlot) || 1;
  return SLOT_COLUMNS[Math.min(4, Math.max(1, slot)) - 1];
}

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Send an already-uploaded loader image to the archive, even when the code
 * has no Positill or website match yet. The archived row is tagged
 * `nutstore` so a later code change re-runs the lookup and auto-allocates
 * description / SOH / price (api/update-product.js).
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const sku = String(body.code || body.sku || '').trim().toUpperCase();
  const imageUrl = String(body.imageUrl || '').trim();
  if (!sku || sku.length < 2) return res.status(400).json({ error: 'code is required' });
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });

  const now = new Date().toISOString();
  const title = String(body.title || '').trim() || String(body.displayCode || '').trim() || sku;
  const imageColumn = slotColumn(body.imageSlot);
  const payload = {
    sku,
    barcode: String(body.barcode || sku).trim(),
    title,
    original_description: String(body.description || '').trim() || title,
    price: Number(body.price ?? body.sqlRow?.price ?? 0) || 0,
    units_of_issue: normalizeUnitsOfIssue(body.unitsOfIssue || 'EACH'),
    pack_description: String(body.packDescription || '').trim(),
    category: String(body.category || '').trim() || ARCHIVE_DEFAULT_CATEGORY,
    subcategory_one: String(body.subcategoryOne || '').trim() || ARCHIVE_DEFAULT_SUB,
    subcategory_two: body.subcategoryTwo || null,
    // Slot-aware: a .2/.3/.4 file must not overwrite image 1. Only the target
    // column is written, so uploading a folder of bashews, bashews.2,
    // bashews.3, bashews.4 fills all four slots instead of fighting over one.
    [imageColumn]: imageUrl,
    archived_by: NUTSTORE_ARCHIVED_BY,
    archived_at: now,
    updated_at: now,
  };
  if (body.sqlRow?.onhand != null) payload.stock_qty = Number(body.sqlRow.onhand);
  if (body.sqlRow?.available != null) payload.available_stock = Number(body.sqlRow.available);

  const sb = getStockClient();
  try {
    const [{ data: liveRow }, { data: archivedRow }] = await Promise.all([
      sb.from('website_stock').select(`sku, ${imageColumn}`).eq('sku', sku).maybeSingle(),
      sb.from('archived_products').select('sku, archived_by').eq('sku', sku).maybeSingle(),
    ]);

    if (archivedRow && archivedRow.archived_by !== NUTSTORE_ARCHIVED_BY) {
      return res.status(409).json({ error: `SKU "${sku}" is archived as "${archivedRow.archived_by}"` });
    }

    let action = 'create';
    if (liveRow) {
      const { error: patchErr } = await sb
        .from('website_stock')
        .update({ [imageColumn]: liveRow[imageColumn] || imageUrl, updated_at: now })
        .eq('sku', sku);
      if (patchErr) throw patchErr;
      const { error: rpcErr } = await sb.rpc('archive_product', { p_sku: sku, p_by: NUTSTORE_ARCHIVED_BY });
      if (rpcErr) throw rpcErr;
      action = 'archive_live';
    } else if (archivedRow) {
      action = 'update';
      const { error } = await sb.from('archived_products').update(payload).eq('sku', sku);
      if (error) throw error;
    } else {
      const { error } = await sb.from('archived_products').insert(payload);
      if (error) throw error;
    }

    await logProductLoaderAudit(sb, {
      sku,
      action: action === 'create' ? 'create' : 'update',
      source: 'local_product_loader',
      publishMode: 'archive',
      imageSlot: Number(body.imageSlot) || 1,
      imageSource: 'upload',
      newValues: {
        outcome: 'archived',
        archivedBy: NUTSTORE_ARCHIVED_BY,
        title,
        matched: Boolean(body.sqlRow || body.websiteRow),
        imageUrl,
        filename: body.filename || null,
      },
      publishedBy: String(body.publishedBy || '').trim() || null,
    });

    return res.status(200).json({ ok: true, sku, action, archivedBy: NUTSTORE_ARCHIVED_BY });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Archive failed' });
  }
}
