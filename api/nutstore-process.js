import { createClient } from '@supabase/supabase-js';
import { catalogueDescription, catalogueDisplayTitle } from '../lib/product-loader-display.mjs';
import { requireOwner } from './_admin-auth.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';
import { downloadNutstoreFile, isNutstoreConfigured, nutstoreSetupMessage } from './_nutstore-webdav.js';
import { normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const BUCKET = 'product-images';
/** Catalogue archive tag — shows in Product Manager → Archived (not dormant queue). */
export const NUTSTORE_ARCHIVED_BY = 'nutstore';
const ARCHIVE_DEFAULT_CATEGORY = 'Uncategorised';
const ARCHIVE_DEFAULT_SUB = 'General';
const SLOT_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

function resolveArchiveCategories(item) {
  const category = String(
    item.category || item.websiteRow?.category || item.sqlRow?.dept || ARCHIVE_DEFAULT_CATEGORY,
  ).trim() || ARCHIVE_DEFAULT_CATEGORY;
  const subcategoryOne = String(
    item.subcategoryOne || item.subcategory_one || item.websiteRow?.subcategory_one || category,
  ).trim() || ARCHIVE_DEFAULT_SUB;
  return { category, subcategoryOne };
}

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function uploadImageBuffer(sb, { sku, slot, filename, buffer, contentType }) {
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  const ext = String(filename).split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const objectPath = `${sku}/${slot}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(objectPath, buffer, {
    contentType: contentType || 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  const { data: { publicUrl } } = sb.storage.from(BUCKET).getPublicUrl(objectPath);
  return publicUrl;
}

async function publishOne(sb, item, { overwriteImage }) {
  const sku = String(item.code || '').trim().toUpperCase();
  const path = String(item.path || '').trim();
  if (!sku || !path) throw new Error('code and path required');

  const category = String(item.category || '').trim();
  const subcategoryOne = String(item.subcategoryOne || item.subcategory_one || category).trim();
  if (!category || !subcategoryOne) throw new Error('category and subcategoryOne required');

  const { buffer, contentType, filename } = await downloadNutstoreFile(path);
  const imageUrl = await uploadImageBuffer(sb, { sku, slot: 1, filename, buffer, contentType });

  const slot = 1;
  const imageField = SLOT_FIELDS[slot - 1];
  const { data: existing, error: lookupErr } = await sb
    .from('website_stock')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  const shouldOverwrite = overwriteImage || item.overwriteImage || item.warnings?.includes('image_exists');
  if (existing?.[imageField] && !shouldOverwrite) {
    const err = new Error(`Image slot 1 already has an image for ${sku}`);
    err.code = 'image_exists';
    throw err;
  }

  const now = new Date().toISOString();
  const { title, description } = resolveCatalogTextFields(item);
  const price = Number(item.price ?? item.sqlRow?.price ?? 0);
  const unitsOfIssue = normalizeUnitsOfIssue(
    item.unitsOfIssue || existing?.units_of_issue || 'EACH',
  );

  const patch = {
    title,
    price,
    units_of_issue: unitsOfIssue,
    pack_description: String(item.packDescription || existing?.pack_description || '').trim(),
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: item.subcategoryTwo || item.subcategory_two || null,
    original_description: description,
    [imageField]: imageUrl,
    updated_at: now,
  };
  if (item.sqlRow?.onhand != null) patch.stock_qty = Number(item.sqlRow.onhand);
  if (item.sqlRow?.available != null) patch.available_stock = Number(item.sqlRow.available);

  let action;
  if (existing) {
    action = 'update';
    const { error } = await sb.from('website_stock').update(patch).eq('sku', sku);
    if (error) throw error;
  } else {
    action = 'create';
    const { error } = await sb.from('website_stock').insert({
      sku,
      barcode: String(item.barcode || sku).trim(),
      ...patch,
      stock_qty: patch.stock_qty ?? 0,
      available_stock: patch.available_stock ?? patch.stock_qty ?? 0,
      image_url_two: null,
      image_url_three: null,
      image_url_four: null,
    });
    if (error) throw error;
  }

  await logProductLoaderAudit(sb, {
    sku,
    action,
    source: 'nutstore_product_loader',
    publishMode: 'direct',
    imageSlot: 1,
    imageSource: 'nutstore',
    oldValues: existing ? { title: existing.title, price: existing.price, [imageField]: existing[imageField] } : null,
    newValues: {
      outcome: 'published',
      title,
      price,
      unitsOfIssue,
      category,
      subcategoryOne,
      imageUrl,
      nutstorePath: path,
      filename: item.filename || filename,
    },
    publishedBy: String(item.publishedBy || '').trim() || null,
  });

  return { sku, action, imageUrl };
}

function resolveCatalogTextFields(item) {
  const hasMatch = Boolean(item.sqlRow || item.websiteRow);
  if (!hasMatch) return { title: '', description: '' };
  return {
    title: catalogueDisplayTitle(item),
    description: catalogueDescription(item),
  };
}

function buildArchivePayload(item, { sku, imageUrl, filename, now }) {
  const { category, subcategoryOne } = resolveArchiveCategories(item);
  const resolved = resolveCatalogTextFields(item);
  // Unmatched codes still archive — placeholder text until a code fix
  // re-links them to Positill (see api/update-product.js re-lookup).
  const title = resolved.title || String(item.displayCode || '').trim() || sku;
  const description = resolved.description || title;
  return {
    sku,
    barcode: sku,
    title,
    original_description: description,
    price: Number(item.price ?? item.sqlRow?.price ?? 0),
    units_of_issue: normalizeUnitsOfIssue(item.unitsOfIssue || 'EACH'),
    pack_description: String(item.packDescription || '').trim(),
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: item.subcategoryTwo || item.subcategory_two || null,
    subcategory_three: item.subcategoryThree || item.subcategory_three || null,
    subcategory_four: item.subcategoryFour || item.subcategory_four || null,
    image_url_one: imageUrl,
    archived_by: NUTSTORE_ARCHIVED_BY,
    archived_at: now,
    updated_at: now,
  };
}

async function archiveOne(sb, item) {
  const sku = String(item.code || '').trim().toUpperCase();
  const path = String(item.path || '').trim();
  if (!sku || !path) throw new Error('code and path required');

  const [{ data: liveRow }, { data: archivedRow }] = await Promise.all([
    sb.from('website_stock').select('*').eq('sku', sku).maybeSingle(),
    sb.from('archived_products').select('sku, archived_by').eq('sku', sku).maybeSingle(),
  ]);

  if (archivedRow && archivedRow.archived_by !== NUTSTORE_ARCHIVED_BY) {
    throw new Error(`SKU "${sku}" is archived as "${archivedRow.archived_by}"`);
  }

  const { buffer, contentType, filename } = await downloadNutstoreFile(path);
  const imageUrl = await uploadImageBuffer(sb, { sku, slot: 1, filename, buffer, contentType });
  const now = new Date().toISOString();
  const payload = buildArchivePayload(item, { sku, imageUrl, filename, now });
  const title = payload.title;

  let archiveAction = 'create';

  if (liveRow) {
    const shouldOverwrite = item.overwriteImage || item.warnings?.includes('image_exists') || !liveRow.image_url_one;
    const livePatch = {
      title: payload.title,
      price: payload.price,
      category: payload.category,
      subcategory_one: payload.subcategory_one,
      subcategory_two: payload.subcategory_two,
      original_description: payload.original_description,
      updated_at: now,
    };
    if (shouldOverwrite || !liveRow.image_url_one) {
      livePatch.image_url_one = imageUrl;
    }
    if (item.sqlRow?.onhand != null) livePatch.stock_qty = Number(item.sqlRow.onhand);
    if (item.sqlRow?.available != null) livePatch.available_stock = Number(item.sqlRow.available);

    const { error: updateErr } = await sb.from('website_stock').update(livePatch).eq('sku', sku);
    if (updateErr) throw updateErr;

    const { error: rpcErr } = await sb.rpc('archive_product', { p_sku: sku, p_by: NUTSTORE_ARCHIVED_BY });
    if (rpcErr) throw rpcErr;
    archiveAction = 'archive_live';
  } else if (archivedRow) {
    archiveAction = 'update';
    const { error } = await sb.from('archived_products').update(payload).eq('sku', sku);
    if (error) throw error;
  } else {
    const { error } = await sb.from('archived_products').insert(payload);
    if (error) throw error;
  }

  await logProductLoaderAudit(sb, {
    sku,
    action: archiveAction === 'create' ? 'create' : 'update',
    source: 'nutstore_product_loader',
    publishMode: 'archive',
    imageSlot: 1,
    imageSource: 'nutstore',
    newValues: {
      outcome: 'archived',
      archivedBy: NUTSTORE_ARCHIVED_BY,
      title,
      category: payload.category,
      subcategoryOne: payload.subcategory_one,
      imageUrl,
      nutstorePath: path,
      filename: item.filename || filename,
    },
    publishedBy: String(item.publishedBy || '').trim() || null,
  });

  return { sku, imageUrl, archivedBy: NUTSTORE_ARCHIVED_BY };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  if (!isNutstoreConfigured()) {
    return res.status(503).json({ error: nutstoreSetupMessage() });
  }

  const { action, items, overwriteImage = false } = req.body || {};
  if (!['publish', 'archive'].includes(action)) {
    return res.status(400).json({ error: 'action must be publish or archive' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items[] required' });
  }

  const sb = getStockClient();
  // Concurrency 4 works with Nutstore's ~350ms paced fetch — WebDAV downloads
  // are the bottleneck. Higher parallelism risks 503 rate-limit errors even
  // with the shared paced fetcher.
  const NUTSTORE_CONCURRENCY = 4;
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      const raw = items[idx];
      const sku = String(raw.code || '').trim().toUpperCase();
      try {
        const result = action === 'publish'
          ? await publishOne(sb, raw, { overwriteImage })
          : await archiveOne(sb, raw);
        results[idx] = { sku, ok: true, ...result };
      } catch (err) {
        results[idx] = { sku, ok: false, error: err.message || 'failed', code: err.code || null };
      }
    }
  }

  const workers = Math.min(NUTSTORE_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);
  return res.status(failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    action,
    processed: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    results,
  });
}
