import { stagingExpiresAt, collectImageUrlsFromRow, removeStagingObjects, isExpiredStaging, resolveLiveImageUrl, storagePathFromPublicUrl, buildLiveObjectPath, publicUrlForPath, repairSkuLiveStagingUrls } from './_staging-storage.js';
import { findProductBySku, fetchProductLookupMap } from './_sku-match.js';

const LIVE_SELECT = `
  id, sku, barcode, title, original_description,
  image_url_one, image_url_two, image_url_three, image_url_four,
  category, subcategory_one, subcategory_two, subcategory_three, subcategory_four,
  created_at, updated_at, price, stock_qty, available_stock, keep_live_when_oos
`;

/**
 * Upsert archived_products preview (archived_by = new-products) while website_stock stays live.
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 */
function slotField(slot) {
  const map = { 1: 'image_url_one', 2: 'image_url_two', 3: 'image_url_three', 4: 'image_url_four' };
  return map[slot] || 'image_url_one';
}

function readSlotUrl(row, slot) {
  const field = slotField(slot);
  return String(row?.[field] || '').split(',')[0].trim();
}

/** Strip query/hash for reliable staged-vs-live comparison. */
export function normalizeImageUrl(url) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.split('?')[0].split('#')[0].replace(/\/$/, '');
  }
}

export async function stageDormantSlotPreview(sb, liveRow, {
  slot = 1,
  imageUrl,
  mergeFromStaged = true,
  stagedBy = null,
  stagedBatchId = null,
} = {}) {
  const sku = String(liveRow.sku || '').trim();
  if (!sku) throw new Error('Missing SKU');
  const targetSlot = Math.min(4, Math.max(1, Number(slot) || 1));
  const processedImageUrl = String(imageUrl || '').trim();
  if (!processedImageUrl) throw new Error('Missing image URL');

  const now = new Date().toISOString();
  const expiresAt = stagingExpiresAt();
  const stagingMeta = {
    staged_expires_at: expiresAt,
    staged_by: stagedBy || null,
    staged_batch_id: stagedBatchId || null,
  };

  const { data: existing } = await sb
    .from('archived_products')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();

  if (existing && isExpiredStaging(existing)) {
    await removeStagingObjects(sb, collectImageUrlsFromRow(existing));
    await sb.from('archived_products').delete().eq('sku', sku).eq('archived_by', 'new-products');
  } else if (existing && existing.archived_by !== 'new-products') {
    throw new Error(`SKU "${sku}" is archived as "${existing.archived_by}" — cannot stage preview`);
  }

  const { data: existingFresh } = await sb
    .from('archived_products')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();

  if (existingFresh && existingFresh.archived_by !== 'new-products') {
    throw new Error(`SKU "${sku}" is archived as "${existingFresh.archived_by}" — cannot stage preview`);
  }

  const base = existingFresh && mergeFromStaged ? existingFresh : liveRow;
  const payload = {
    sku,
    barcode: liveRow.barcode,
    title: liveRow.title,
    original_description: liveRow.original_description,
    image_url_one: base.image_url_one ?? liveRow.image_url_one,
    image_url_two: base.image_url_two ?? liveRow.image_url_two,
    image_url_three: base.image_url_three ?? liveRow.image_url_three,
    image_url_four: base.image_url_four ?? liveRow.image_url_four,
    category: liveRow.category,
    subcategory_one: liveRow.subcategory_one,
    subcategory_two: liveRow.subcategory_two,
    subcategory_three: liveRow.subcategory_three,
    subcategory_four: liveRow.subcategory_four,
    created_at: liveRow.created_at || now,
    updated_at: now,
    price: liveRow.price ?? null,
    stock_qty: liveRow.stock_qty ?? null,
    available_stock: liveRow.available_stock ?? null,
    keep_live_when_oos: liveRow.keep_live_when_oos ?? false,
    archived_at: now,
    archived_by: 'new-products',
    ...stagingMeta,
  };
  payload[slotField(targetSlot)] = processedImageUrl;

  const isMissingStagingColumn = (err) => /staged_(expires_at|by|batch_id)/i.test(String(err?.message || ''));

  if (existingFresh) {
    const patch = {
      updated_at: now,
      [slotField(targetSlot)]: processedImageUrl,
      ...stagingMeta,
    };
    let { error } = await sb.from('archived_products').update(patch).eq('sku', sku);
    if (error && isMissingStagingColumn(error)) {
      const { staged_expires_at, staged_by, staged_batch_id, ...patchWithoutMeta } = patch;
      ({ error } = await sb.from('archived_products').update(patchWithoutMeta).eq('sku', sku));
    }
    if (error) throw new Error(error.message);
  } else {
    let { error } = await sb.from('archived_products').insert({ ...payload, id: liveRow.id });
    if (error && isMissingStagingColumn(error)) {
      const { staged_expires_at, staged_by, staged_batch_id, ...payloadWithoutMeta } = payload;
      ({ error } = await sb.from('archived_products').insert({ ...payloadWithoutMeta, id: liveRow.id }));
    }
    if (error) throw new Error(error.message);
  }

  const { data: stillLive } = await sb.from('website_stock').select('sku').eq('sku', sku).maybeSingle();
  return { stillLive: !!stillLive, slot: targetSlot, imageUrl: processedImageUrl, expiresAt };
}

export async function stageDormantPreview(sb, liveRow, processedImageUrl) {
  return stageDormantSlotPreview(sb, liveRow, { slot: 1, imageUrl: processedImageUrl });
}

export { readSlotUrl, slotField };

const IMAGE_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

/** Swap two staged preview slots (1–4) on archived_products before Approval go-live. */
export async function reorderStagedImageSlots(sb, sku, fromSlot, toSlot) {
  const cleanSku = String(sku || '').trim();
  const a = Math.min(4, Math.max(1, Number(fromSlot) || 1));
  const b = Math.min(4, Math.max(1, Number(toSlot) || 1));
  if (!cleanSku || a === b) return null;

  const { data: row, error } = await sb
    .from('archived_products')
    .select('*')
    .eq('sku', cleanSku)
    .eq('archived_by', 'new-products')
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error(`No staged preview for "${cleanSku}"`);

  const urls = IMAGE_FIELDS.map((_, i) => readSlotUrl(row, i + 1));
  [urls[a - 1], urls[b - 1]] = [urls[b - 1], urls[a - 1]];

  const patch = { updated_at: new Date().toISOString() };
  IMAGE_FIELDS.forEach((field, i) => {
    patch[field] = urls[i] || null;
  });

  const { error: upErr } = await sb
    .from('archived_products')
    .update(patch)
    .eq('sku', cleanSku)
    .eq('archived_by', 'new-products');
  if (upErr) throw upErr;

  return { images: urls };
}

/** Merge staged image slots onto a live row — only changed / newly generated URLs apply. */
export function mergeStagedImagesOntoLive(staged, live) {
  const merged = {};
  const appliedSlots = [];
  IMAGE_FIELDS.forEach((field, i) => {
    const slot = i + 1;
    const stagedRaw = readSlotUrl(staged, slot);
    const liveRaw = live ? readSlotUrl(live, slot) : '';
    const stagedNorm = normalizeImageUrl(stagedRaw);
    const liveNorm = normalizeImageUrl(liveRaw);

    if (stagedRaw) {
      merged[field] = stagedRaw;
      if (stagedNorm !== liveNorm) {
        appliedSlots.push(slot);
      }
    } else if (live) {
      merged[field] = live[field] ?? null;
    } else {
      merged[field] = null;
    }
  });
  return { merged, appliedSlots };
}

function readStock(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Require price + SOH from source-of-truth products table (via barcode / product SKU). */
export async function validateStockReady(sb, barcode) {
  const key = String(barcode || '').trim();
  if (!key) return { ok: false, error: 'Missing barcode/SKU for stock lookup' };

  const lookupMap = await fetchProductLookupMap(sb, [key], 'sku, sell_price, available_stock, stock_qty');
  const product = findProductBySku(lookupMap, key);
  if (!product) return { ok: false, error: `No stock record for "${key}" — add price and SOH in the stock system first` };

  const price = readStock(product.sell_price);
  if (price === null || price <= 0) {
    return { ok: false, error: `Missing or zero price for "${key}" in stock system` };
  }

  const soh = readStock(product.available_stock) ?? readStock(product.stock_qty);
  if (soh === null) {
    return { ok: false, error: `Missing stock/SOH for "${key}" in stock system` };
  }

  return { ok: true, price, soh };
}

/**
 * Batch version of validateStockReady — single DB query for all barcodes.
 * Returns a Map<barcode, {ok, price?, soh?, error?}>.
 */
export async function batchValidateStockReady(sb, barcodes) {
  const keys = [...new Set(barcodes.map((b) => String(b || '').trim()).filter(Boolean))];
  const result = new Map();

  if (!keys.length) return result;

  const lookupMap = await fetchProductLookupMap(sb, keys, 'sku, sell_price, available_stock, stock_qty');

  for (const key of keys) {
    const product = findProductBySku(lookupMap, key);
    if (!product) {
      result.set(key, { ok: false, error: `No stock record for "${key}" — add price and SOH in the stock system first` });
      continue;
    }
    const price = readStock(product.sell_price);
    if (price === null || price <= 0) {
      result.set(key, { ok: false, error: `Missing or zero price for "${key}" in stock system` });
      continue;
    }
    const soh = readStock(product.available_stock) ?? readStock(product.stock_qty);
    if (soh === null) {
      result.set(key, { ok: false, error: `Missing stock/SOH for "${key}" in stock system` });
      continue;
    }
    result.set(key, { ok: true, price, soh });
  }

  return result;
}

/** Apply staged New Products image to live site, or unarchive brand-new dormant SKUs. */
export async function applyDormantToLive(sb, sku) {
  const cleanSku = String(sku || '').trim();
  if (!cleanSku) throw new Error('sku is required');

  const { data: staged, error: stagedErr } = await sb
    .from('archived_products')
    .select('*')
    .eq('sku', cleanSku)
    .eq('archived_by', 'new-products')
    .maybeSingle();
  if (stagedErr) throw new Error(stagedErr.message);

  const { data: live, error: liveErr } = await sb
    .from('website_stock')
    .select(LIVE_SELECT)
    .eq('sku', cleanSku)
    .maybeSingle();
  if (liveErr) throw new Error(liveErr.message);

  if (!staged) {
    if (live) {
      const repaired = await repairSkuLiveStagingUrls(sb, live);
      if (repaired.changed) {
        return {
          mode: 'image_applied',
          sku: cleanSku,
          imageUrl: repaired.patch?.image_url_one || readSlotUrl(live, 1),
          appliedSlots: [1, 2, 3, 4].filter((s) => repaired.patch?.[slotField(s)] != null),
        };
      }
    }
    throw new Error(`No staged preview for "${cleanSku}" — run image gen again or refresh Approval`);
  }

  if (live) {
    const { merged, appliedSlots } = mergeStagedImagesOntoLive(staged, live);

    if (appliedSlots.length) {
      const patch = { updated_at: new Date().toISOString() };
      await Promise.all(appliedSlots.map(async (slot) => {
        const field = slotField(slot);
        const stagedUrl = merged[field];
        const resolved = await resolveLiveImageUrl(sb, stagedUrl, cleanSku, slot);
        if (!resolved) {
          throw new Error(`Image slot ${slot} for "${cleanSku}" is missing — re-run image gen for this product`);
        }
        merged[field] = resolved;
        patch[field] = resolved;
      }));

      const { data: updated, error: updateErr } = await sb
        .from('website_stock')
        .update(patch)
        .eq('sku', cleanSku)
        .select('sku, image_url_one, image_url_two, image_url_three, image_url_four')
        .maybeSingle();
      if (updateErr) throw new Error(updateErr.message);
      if (!updated) throw new Error(`Could not update live product "${cleanSku}" — row missing or permission denied`);

      for (const slot of appliedSlots) {
        const field = slotField(slot);
        const expected = normalizeImageUrl(merged[field]);
        const actual = normalizeImageUrl(readSlotUrl(updated, slot));
        if (expected && expected !== actual) {
          throw new Error(`Image slot ${slot} did not persist for "${cleanSku}" — retry or check Supabase permissions`);
        }
      }
    }

    const { error: delErr } = await sb
      .from('archived_products')
      .delete()
      .eq('sku', cleanSku)
      .eq('archived_by', 'new-products');
    if (delErr) throw new Error(delErr.message);

    await removeStagingObjects(sb, collectImageUrlsFromRow(staged));

    const primaryUrl = merged.image_url_one || readSlotUrl(live, 1);
    return {
      mode: appliedSlots.length ? 'image_applied' : 'already_live',
      sku: cleanSku,
      imageUrl: primaryUrl,
      appliedSlots,
    };
  }

  const stockCheck = await validateStockReady(sb, staged.barcode || cleanSku);
  if (!stockCheck.ok) throw new Error(stockCheck.error);

  for (let s = 1; s <= 4; s += 1) {
    const field = slotField(s);
    const url = readSlotUrl(staged, s);
    if (url && storagePathFromPublicUrl(url)?.startsWith('staging/')) {
      staged[field] = await resolveLiveImageUrl(sb, url, cleanSku, s);
    }
  }

  const { error: unarchiveErr } = await sb.rpc('unarchive_product', { p_sku: cleanSku });
  if (unarchiveErr) throw new Error(unarchiveErr.message);
  return { mode: 'unarchived', sku: cleanSku, imageUrl: staged.image_url_one, price: stockCheck.price, soh: stockCheck.soh };
}
