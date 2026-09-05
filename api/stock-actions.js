import { requireOwner } from './_admin-auth.js';
import { loadTaxonomy } from './_taxonomy-utils.js';
import { getStockClient, enrichRowsWithProductStock } from './_stock-client.js';
import { ensureProductFromCatalogueRow, restoreArchivedToLive } from './_ensure-product.js';
import { collectImageUrlsFromRow, removeStagingObjects } from './_staging-storage.js';
import { reorderStagedImageSlots } from './_stage-dormant.js';
import { isExactlyZeroStock } from './_catalog-adapt.js';
import { detachSkuFromGroup } from './_group-cascade.js';
import { normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';
import { INCOMING_STOCK_STATUSES, normalizeIncomingAvailability } from '../lib/product-availability.mjs';

// maxDuration for this route is set in vercel.json (functions."api/stock-actions.js").
const PAGE_SIZE = 1000;

/** Columns needed for admin catalogue adapt() — avoids select('*') timeouts on ~5k rows. */
const LIVE_LIST_COLS = [
  'sku', 'barcode', 'title', 'category',
  'subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four', 'subcategory_extra',
  'image_url_one', 'image_url_two', 'image_url_three', 'image_url_four',
  'price', 'stock_qty', 'available_stock', 'is_new_arrival', 'to_order',
  'original_description', 'pack_description', 'units_of_issue', 'min_order_qty',
  'created_at', 'updated_at', 'keep_live_when_oos',
].join(', ');

// Above this, a single unbounded listing is loading enough rows into serverless
// memory to be worth flagging (see catalog.js FULL_SCAN_WARN_ROWS) — logged, not
// enforced, so listings stay complete while the size is surfaced for ops.
const FULL_SCAN_WARN_ROWS = 15000;

function availabilityTableMissing(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /PGRST205|42P01|website_product_availability/i.test(text);
}

async function fetchAllRows(supabase, table, { filter = null, orderBy = null, select = '*' } = {}) {
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select);
    if (orderBy) q = q.order(orderBy, { ascending: true });
    q = q.range(from, from + PAGE_SIZE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  if (rows.length > FULL_SCAN_WARN_ROWS) {
    console.warn(`stock-actions full listing large: ${rows.length} rows from ${table} (threshold ${FULL_SCAN_WARN_ROWS}) — consider server-side pagination.`);
  }
  return rows;
}

/** Attach live SOH from public.products via website_product_links (fallback: barcode). */
async function enrichRowsWithProductStockLocal(supabase, rows) {
  return enrichRowsWithProductStock(supabase, rows);
}

/**
 * Server-side stock mutations + raw listings. Replaces direct browser access
 * to the stock Supabase project so its key never ships in the client bundle.
 */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};
  const supabase = getStockClient();

  try {
    if (action === 'listLive') {
      const [rows, tree] = await Promise.all([
        fetchAllRows(supabase, 'website_stock', { orderBy: 'title', select: LIVE_LIST_COLS }),
        loadTaxonomy().catch(() => []),
      ]);
      return res.status(200).json({ rows, tree });
    }

    if (action === 'listArchived') {
      const { archivedBy = null, excludeArchivedBy = null } = req.body;
      const [rawRows, tree, liveRows] = await Promise.all([
        fetchAllRows(supabase, 'archived_products', {
          orderBy: 'archived_at',
          filter: archivedBy ? (q) => q.eq('archived_by', archivedBy) : null,
        }),
        loadTaxonomy().catch(() => []),
        archivedBy === 'new-products'
          ? fetchAllRows(supabase, 'website_stock', { orderBy: 'sku' }).catch(() => [])
          : Promise.resolve([]),
      ]);
      const filtered = Array.isArray(excludeArchivedBy) && excludeArchivedBy.length
        ? rawRows.filter((r) => !excludeArchivedBy.includes(r.archived_by))
        : rawRows;
      const liveSkuSet = new Set((liveRows || []).map((r) => r.sku));
      const withLiveFlag = filtered.map((r) => (
        archivedBy === 'new-products' ? { ...r, still_live: liveSkuSet.has(r.sku) } : r
      ));
      let rows = await enrichRowsWithProductStockLocal(supabase, withLiveFlag);
      if (Array.isArray(excludeArchivedBy) && excludeArchivedBy.length) {
        rows = rows.filter((r) => !isExactlyZeroStock(r));
      }
      return res.status(200).json({ rows, tree });
    }

    if (action === 'create') {
      const { row } = req.body;
      if (!row?.sku || !row?.barcode || !row?.title || !row?.category) {
        return res.status(400).json({ error: 'sku, barcode, title and category are required' });
      }
      const ALLOWED = new Set([
        'sku', 'barcode', 'title', 'original_description', 'price', 'category',
        'subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four', 'subcategory_extra',
        'image_url_one', 'image_url_two', 'image_url_three', 'image_url_four',
        'units_of_issue', 'pack_description', 'min_order_qty',
      ]);
      const clean = Object.fromEntries(Object.entries(row).filter(([k]) => ALLOWED.has(k)));
      clean.units_of_issue = normalizeUnitsOfIssue(clean.units_of_issue || 'EACH');
      clean.min_order_qty = Math.max(1, Math.min(9999, Math.floor(Number(clean.min_order_qty) || 1)));
      // subcategory_one is NOT NULL — default to the shallow-row convention
      // (duplicate the category) so non-UI callers can't trip the constraint.
      if (!String(clean.subcategory_one || '').trim()) clean.subcategory_one = clean.category;
      const { error } = await supabase.from('website_stock').insert(clean);
      if (error) throw error;
      await ensureProductFromCatalogueRow(supabase, clean);
      return res.status(200).json({ ok: true });
    }

    if (action === 'archive') {
      const { sku, by = 'product-manager' } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const { error } = await supabase.rpc('archive_product', { p_sku: sku, p_by: String(by).slice(0, 60) });
      if (error) throw error;
      // Archiving removes the SKU from the live catalogue, so detach it from any
      // variant group (promote a new primary / disband) to avoid a group whose
      // card points at an archived product.
      await detachSkuFromGroup(supabase, sku);
      return res.status(200).json({ ok: true });
    }

    if (action === 'unarchive' || action === 'restoreToLive') {
      const { sku } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const result = await restoreArchivedToLive(supabase, sku);
      return res.status(200).json(result);
    }

    if (action === 'setToOrder') {
      // Mark a product orderable at zero stock (with a storefront lead-time
      // disclaimer). Updates whichever table the SKU lives in so it works from
      // the live catalogue and the archive.
      //
      // Enabling "to order" ALSO sets keep_live_when_oos = true: a to-order
      // product must stay both VISIBLE and ORDERABLE at zero stock, and without
      // the keep-live flag the auto-OOS rule (migration 018) would archive it
      // out from under the customer — making it un-orderable. Un-marking clears
      // only the order flag; visibility (keep_live_when_oos) is left as
      // configured, since a product can still be pinned-live without being
      // orderable.
      const { sku, toOrder } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const patch = toOrder
        ? { to_order: true, keep_live_when_oos: true, updated_at: new Date().toISOString() }
        : { to_order: false, updated_at: new Date().toISOString() };
      const live = await supabase.from('website_stock').update(patch).eq('sku', sku).select('sku');
      if (live.error) throw live.error;
      if (!live.data?.length) {
        const arch = await supabase.from('archived_products').update(patch).eq('sku', sku).select('sku');
        if (arch.error) throw arch.error;
        if (!arch.data?.length) return res.status(404).json({ error: 'Product not found' });
      }
      return res.status(200).json({ ok: true, toOrder: !!toOrder });
    }

    if (action === 'getProductAvailability') {
      const sku = String(req.body?.sku || '').trim();
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const { data, error } = await supabase
        .from('website_product_availability')
        .select('sku, incoming_status, incoming_qty, incoming_eta, shipment_ref, allow_preorder, updated_at')
        .eq('sku', sku)
        .maybeSingle();
      if (error && availabilityTableMissing(error)) {
        return res.status(200).json({ schemaReady: false, availability: normalizeIncomingAvailability() });
      }
      if (error) throw error;
      return res.status(200).json({
        schemaReady: true,
        availability: normalizeIncomingAvailability(data || {}),
        updatedAt: data?.updated_at || null,
      });
    }

    if (action === 'setProductAvailability') {
      const sku = String(req.body?.sku || '').trim();
      const incomingStatus = String(req.body?.incomingStatus || 'none');
      const incomingQty = Number(req.body?.incomingQty || 0);
      const incomingEta = String(req.body?.incomingEta || '').trim();
      const shipmentRef = String(req.body?.shipmentRef || '').trim().slice(0, 120);
      const allowPreorder = Boolean(req.body?.allowPreorder);

      if (!sku) return res.status(400).json({ error: 'sku required' });
      if (!INCOMING_STOCK_STATUSES.includes(incomingStatus)) {
        return res.status(400).json({ error: 'Invalid incoming stock status' });
      }
      if (!Number.isFinite(incomingQty) || incomingQty < 0 || incomingQty > 1000000000) {
        return res.status(400).json({ error: 'Incoming quantity must be between 0 and 1,000,000,000' });
      }
      if (incomingStatus !== 'none' && incomingQty <= 0) {
        return res.status(400).json({ error: 'Enter the expected incoming quantity' });
      }
      if (incomingEta && !/^\d{4}-\d{2}-\d{2}$/.test(incomingEta)) {
        return res.status(400).json({ error: 'ETA must be a valid date' });
      }

      const { data: product, error: productError } = await supabase
        .from('website_stock')
        .select('sku')
        .eq('sku', sku)
        .maybeSingle();
      if (productError) throw productError;
      if (!product) return res.status(404).json({ error: 'Product not found in the live catalogue' });

      if (incomingStatus === 'none') {
        const { error } = await supabase.from('website_product_availability').delete().eq('sku', sku);
        if (error && availabilityTableMissing(error)) {
          return res.status(503).json({ error: 'Availability migration 059 has not been applied' });
        }
        if (error) throw error;
        return res.status(200).json({ ok: true, availability: normalizeIncomingAvailability() });
      }

      const row = {
        sku,
        incoming_status: incomingStatus,
        incoming_qty: incomingQty,
        incoming_eta: incomingEta || null,
        shipment_ref: shipmentRef,
        allow_preorder: ['on_the_way', 'customs'].includes(incomingStatus) && allowPreorder,
        updated_at: new Date().toISOString(),
        updated_by: 'admin-portal',
      };
      const { data, error } = await supabase
        .from('website_product_availability')
        .upsert(row, { onConflict: 'sku' })
        .select('incoming_status, incoming_qty, incoming_eta, shipment_ref, allow_preorder')
        .single();
      if (error && availabilityTableMissing(error)) {
        return res.status(503).json({ error: 'Availability migration 059 has not been applied' });
      }
      if (error) throw error;
      // Any explicitly tracked shipment must remain visible at zero SOH so the
      // storefront can communicate its real status. This never changes ERP
      // stock and clearing the shipment does not silently hide the product.
      const { error: visibilityError } = await supabase
        .from('website_stock')
        .update({ keep_live_when_oos: true, updated_at: new Date().toISOString() })
        .eq('sku', sku);
      if (visibilityError) throw visibilityError;
      return res.status(200).json({ ok: true, availability: normalizeIncomingAvailability(data) });
    }

    if (action === 'setNewArrival') {
      // Toggle the New Arrivals flag (drives the storefront "New Stock"
      // collection via is_new_arrival). New Arrivals is a live-catalogue concept
      // and the button only appears on live rows, so this targets website_stock.
      const { sku, isNewArrival } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const patch = { is_new_arrival: !!isNewArrival, updated_at: new Date().toISOString() };
      const { data, error } = await supabase.from('website_stock').update(patch).eq('sku', sku).select('sku');
      if (error) throw error;
      if (!data?.length) return res.status(404).json({ error: 'Product not found in the live catalogue' });
      return res.status(200).json({ ok: true, isNewArrival: !!isNewArrival });
    }

    if (action === 'recycleFromArchive') {
      const { sku, archivedBy } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const { error } = await supabase
        .from('archived_products')
        .update({ archived_by: String(archivedBy || 'recycle-bin').slice(0, 60), archived_at: new Date().toISOString() })
        .eq('sku', sku);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === 'deleteStagedPreview') {
      const { sku } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const { data: staged } = await supabase
        .from('archived_products')
        .select('*')
        .eq('sku', sku)
        .eq('archived_by', 'new-products')
        .maybeSingle();
      if (staged) {
        await removeStagingObjects(supabase, collectImageUrlsFromRow(staged));
      }
      const { error } = await supabase
        .from('archived_products')
        .delete()
        .eq('sku', sku)
        .eq('archived_by', 'new-products');
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === 'reorderStagedImages') {
      const { sku, fromSlot, toSlot } = req.body || {};
      if (!sku) return res.status(400).json({ error: 'sku required' });
      const from = Number(fromSlot);
      const to = Number(toSlot);
      if (!from || !to || from < 1 || from > 4 || to < 1 || to > 4) {
        return res.status(400).json({ error: 'fromSlot and toSlot must be 1–4' });
      }
      const result = await reorderStagedImageSlots(supabase, sku, from, to);
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('stock-actions error:', err.message);
    return res.status(500).json({ error: err.message || 'Stock action failed' });
  }
}
