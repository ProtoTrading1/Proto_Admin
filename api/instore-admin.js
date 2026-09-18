import { requireOwner, verifyAdminUser } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { fetchStmastRow, sqlRowToPreview } from './_sql-stmast.js';
import { websitePriceFromExVat } from '../lib/catalogue-price.mjs';
import { createHash } from 'node:crypto';
import { cleanSku, parseInstoreFilename, decodeImageBase64, availabilityFor, publicItem, INSTORE_STATES, INSTORE_MODES } from '../lib/instore-intake.mjs';
import { getInstorePreviewSafety } from './_instore-preview-safety.js';

const TABLE = 'instore_admin_items';
const PAGE_SIZE = 50;
const BUCKET = 'instore-intake';
const publishEnabled = () => process.env.INSTORE_ADMIN_PUBLISH_ENABLED === 'true' && process.env.INSTORE_STOREFRONT_CONTRACT === 'v1';

function actor(req) { return verifyAdminUser(req).then((u) => u?.email || 'owner-admin-key'); }
function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }
function json(res, status, body) { return res.status(status).json(body); }
async function withSignedImage(sb, row) {
  if (!row?.image_path) return publicItem(row);
  const signed = await sb.storage.from(BUCKET).createSignedUrl(row.image_path, 300);
  return publicItem({ ...row, image_url: signed.data?.signedUrl || null });
}

async function optionalWebsiteSource(sb, sku) {
  try {
    const result = await sb.from('website_stock')
      .select('sku, title, original_description, units_of_issue, category')
      .eq('sku', sku).maybeSingle();
    return result.error ? null : result.data;
  } catch {
    // The disposable review branch intentionally starts with a reduced source
    // schema. It must show a review error, never invent source attributes.
    return null;
  }
}

async function syncItem(sb, item) {
  const sku = cleanSku(item.sku);
  // This is a private review overlay. Existing Positill/extended-range items
  // are its intended source; never reject them as "duplicates" or write back
  // to their catalogue records.
  const website = await optionalWebsiteSource(sb, sku);
  const raw = await fetchStmastRow(sku).catch(() => null);
  if (!raw || String(raw.CODE || raw.code || '').trim().toUpperCase() !== sku) {
    return { review_error: 'positill_exact_lookup_unavailable', snapshot: { code: sku } };
  }
  const numeric = ['PRICE_A', 'ONHAND', 'BOOKED'].every((key) => raw[key] != null && Number.isFinite(Number(raw[key])));
  if (!numeric) return { review_error: 'positill_numeric_fields_invalid', snapshot: { raw } };
  const preview = sqlRowToPreview(raw);
  const { data: product, error: productError } = await sb.from('products').select('sku, units_of_issue').eq('sku', sku).maybeSingle();
  if (productError) return { review_error: 'products_lookup_failed', snapshot: { error: productError.message } };
  const mode = item.availability_mode || 'positill';
  const availability = mode === 'stock_available'
    ? availabilityFor({ available: item.confirmed_qty, mode })
    : availabilityFor({ available: preview.available, onhand: preview.onhand, mode });
  const patch = {
    title: website?.title || preview.title,
    price_ex_vat: Number(preview.price) || null,
    price_incl_vat: Number(preview.price) > 0 ? websitePriceFromExVat(preview.price) : null,
    recorded_stock: preview.onhand,
    confirmed_qty: mode === 'stock_available' ? availability.confirmedQty : null,
    availability_mode: mode,
    units_of_issue: website?.units_of_issue || product?.units_of_issue || null,
    review_error: !(website?.units_of_issue || product?.units_of_issue) ? 'units_of_issue_missing' : availability.error,
    // Preserve the customer-facing copy as source evidence; the review table
    // deliberately does not overwrite the main website description.
    snapshot: { raw, preview, website, source: 'erp_sql_plus_website_snapshot' },
  };
  if (!patch.price_incl_vat) patch.review_error = patch.review_error || 'price_missing';
  return patch;
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const previewSafety = getInstorePreviewSafety();
  if (!previewSafety.ok) return json(res, 503, { error: previewSafety.error });
  const sb = getStockClient();
  try {
    if (req.method === 'GET') {
      const state = String(req.query?.status || 'archived');
      if (!INSTORE_STATES.has(state)) return json(res, 400, { error: 'Invalid status' });
      const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query?.page) || 1)));
      const q = String(req.query?.q || '').trim();
      let query = sb.from(TABLE).select('*', { count: 'exact' }).eq('status', state).order('updated_at', { ascending: false });
      if (q) { const safe = q.replace(/[^A-Za-z0-9 _.\\-]/g, ' ').slice(0, 80); query = query.or(`sku.ilike.%${safe}%,title.ilike.%${safe}%`); }
      const { data, error, count } = await query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (error) throw error;
      return json(res, 200, { items: await Promise.all((data || []).map((row) => withSignedImage(sb, row))), total: count || 0, page, pageSize: PAGE_SIZE, publishEnabled: publishEnabled() });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    const sku = cleanSku(body.sku);
    const by = await actor(req);
    if (action === 'stage') {
      if (!uuid(body.batchId)) return json(res, 400, { error: 'batchId UUID is required' });
      const parsed = parseInstoreFilename(body.filename);
      if (!parsed.sku) return json(res, 400, { error: parsed.error });
      let bytes;
      try { bytes = decodeImageBase64(body.imageBase64, body.contentType); } catch (error) { return json(res, 400, { error: error.message }); }
      const { data: existingInstore, error: existingError } = await sb.from(TABLE).select('sku, version').eq('sku', parsed.sku).maybeSingle();
      if (existingError) throw existingError;
      if (existingInstore) {
        const existing = await sb.from(TABLE).select('*').eq('sku', parsed.sku).maybeSingle();
        return json(res, 200, { item: publicItem(existing.data), idempotent: true });
      }
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
      const path = `${body.batchId}/${parsed.sku}/s${parsed.imageSlot}-${digest}.${String(body.contentType).split('/')[1].replace('jpeg', 'jpg')}`;
      const upload = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: body.contentType, upsert: false });
      if (upload.error && !/already exists|duplicate/i.test(upload.error.message || '')) throw upload.error;
      const sourcePatch = await syncItem(sb, { sku: parsed.sku, availability_mode: 'positill' });
      const patch = { filename: String(body.filename), batch_id: body.batchId, image_path: path, status: 'archived', ...sourcePatch };
      const inserted = await sb.rpc('instore_admin_transition', { p_sku: parsed.sku, p_expected_version: null, p_action: 'stage', p_actor: by, p_patch: patch });
      if (inserted.error) throw inserted.error;
      return json(res, 201, { item: publicItem(inserted.data) });
    }
    if (!sku) return json(res, 400, { error: 'sku is required' });
    const current = await sb.from(TABLE).select('*').eq('sku', sku).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return json(res, 404, { error: 'Instore item not found' });
    if (body.version == null) return json(res, 400, { error: 'version is required' });
    if (Number(body.version) !== Number(current.data.version)) return json(res, 409, { error: 'stale_version', item: publicItem(current.data) });
    if (action === 'update') {
      const patch = {};
      const draft = body.patch || {};
      for (const k of ['title', 'category', 'availability_mode']) if (draft[k] != null) patch[k] = String(draft[k]);
      if (draft.availability_mode && !INSTORE_MODES.has(draft.availability_mode)) return json(res, 400, { error: 'Invalid availability_mode' });
      if (draft.confirmed_qty != null && (!Number.isInteger(Number(draft.confirmed_qty)) || Number(draft.confirmed_qty) < 0 || Number(draft.confirmed_qty) > 1000000000)) return json(res, 400, { error: 'confirmed_qty must be a bounded non-negative integer' });
      const nextMode = patch.availability_mode || current.data.availability_mode || 'positill';
      if (nextMode === 'stock_available') {
        const quantity = draft.confirmed_qty;
        if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > 1000000000) {
          return json(res, 400, { error: 'Stock available requires a confirmed whole quantity of at least 1' });
        }
        patch.confirmed_qty = Number(quantity);
      } else {
        // Manual stock caps are only meaningful for physical stock overrides.
        // Never retain one when an item returns to normal Positill or To order.
        patch.confirmed_qty = null;
      }
      const out = await sb.rpc('instore_admin_transition', { p_sku: sku, p_expected_version: current.data.version, p_action: 'update', p_actor: by, p_patch: patch });
      if (out.error) throw out.error; return json(res, 200, { item: publicItem(out.data) });
    }
    if (action === 'sync') {
      const patch = await syncItem(sb, current.data);
      const out = await sb.rpc('instore_admin_transition', { p_sku: sku, p_expected_version: current.data.version, p_action: 'sync', p_actor: by, p_patch: patch });
      if (out.error) throw out.error; return json(res, 200, { item: publicItem(out.data) });
    }
    if (action === 'approve' || action === 'publish') {
      if (!publishEnabled()) return json(res, 503, { error: 'Instore approval/publication is disabled until storefront compatibility is enabled.' });
      const fresh = await syncItem(sb, current.data);
      if (fresh.review_error) return json(res, 422, { error: fresh.review_error });
      const result = await sb.rpc('instore_admin_transition', { p_sku: sku, p_expected_version: current.data.version, p_action: action, p_actor: by, p_patch: fresh });
      if (result.error) throw result.error;
      return json(res, 200, { ok: true, item: publicItem(result.data) });
    }
    if (['archive', 'recycle', 'restore'].includes(action)) {
      const result = await sb.rpc('instore_admin_transition', { p_sku: sku, p_expected_version: current.data.version, p_action: action, p_actor: by, p_patch: {} });
      if (result.error) throw result.error; return json(res, 200, { ok: true, item: publicItem(result.data) });
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (error) { console.error('instore-admin:', error?.message || error); return json(res, /40001|stale_version|version/i.test(error?.code || error?.message || '') ? 409 : 500, { error: error?.message || 'Instore admin request failed' }); }
}
