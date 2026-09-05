/** 7-day temporary staging for generated image previews. */

export const STAGING_TTL_DAYS = 7;
const BUCKET = 'product-images';

export function stagingExpiresAt(fromMs = Date.now()) {
  return new Date(fromMs + STAGING_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function isExpiredStaging(row) {
  const exp = row?.staged_expires_at;
  if (!exp) return false;
  return new Date(exp).getTime() <= Date.now();
}

/** Permanent catalogue path: SKU/1.jpg */
export function buildLiveObjectPath(sku, slot = 1) {
  const safeSku = String(sku || 'product').replace(/[^a-zA-Z0-9._-]/g, '_');
  const s = Math.min(4, Math.max(1, Number(slot) || 1));
  return `${safeSku}/${s}.jpg`;
}

/**
 * Immutable permanent object for an explicitly approved Image Processing
 * Centre result. Unlike buildLiveObjectPath(), this never replaces the
 * existing SKU/slot object, which keeps a rollback target intact and avoids
 * changing storage before the database stale-write check succeeds.
 */
export function buildImageProcessingLiveObjectPath(sku, slot = 1, attemptId = '') {
  const safeSku = String(sku || 'product').replace(/[^a-zA-Z0-9._-]/g, '_');
  const s = Math.min(4, Math.max(1, Number(slot) || 1));
  const safeAttempt = String(attemptId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `image-processing/live/${safeSku}/s${s}/${safeAttempt}.jpg`;
}

function isImageProcessingStagingPath(path) {
  return String(path || '').startsWith('staging/image-processing/');
}

function isImageProcessingLivePath(path) {
  return String(path || '').startsWith('image-processing/live/');
}

/**
 * Copy (never move) an approved IPC staging candidate into a versioned live
 * location. The caller must still conditionally update website_stock after
 * this succeeds; if that update loses a race, removeImageProcessingLiveUrl()
 * removes this copy and the staged candidate remains recoverable.
 */
export async function copyImageProcessingStagedUrlToLive(supabase, url, sku, slot = 1, attemptId = '') {
  const sourcePath = storagePathFromPublicUrl(url);
  if (!isImageProcessingStagingPath(sourcePath)) {
    throw new Error('Approved image is not an Image Processing Centre staging candidate');
  }
  const destinationPath = buildImageProcessingLiveObjectPath(sku, slot, attemptId);
  const bucket = supabase.storage.from(BUCKET);
  const { error } = await bucket.copy(sourcePath, destinationPath);
  if (error) throw new Error(`Could not preserve approved image: ${error.message}`);
  return { path: destinationPath, url: publicUrlForPath(supabase, destinationPath) };
}

/** Remove only an IPC versioned copy that was not applied to website_stock. */
export async function removeImageProcessingLiveUrl(supabase, url) {
  const path = storagePathFromPublicUrl(url);
  if (!isImageProcessingLivePath(path)) return { removed: 0 };
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) {
    console.warn('removeImageProcessingLiveUrl:', error.message);
    return { removed: 0 };
  }
  return { removed: 1 };
}

export function isImageProcessingAssetUrl(url) {
  const path = storagePathFromPublicUrl(url);
  return isImageProcessingStagingPath(path) || isImageProcessingLivePath(path);
}

export function publicUrlForPath(supabase, path) {
  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return publicUrl;
}

async function storageObjectExists(supabase, path) {
  const parts = String(path || '').split('/');
  const name = parts.pop();
  const folder = parts.join('/');
  if (!name) return false;
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { search: name, limit: 5 });
  if (error) return false;
  return (data || []).some((f) => f.name === name);
}

/** Move staging/* object to permanent SKU/slot.jpg via server-side rename (no download). */
export async function promoteStagingUrlToLive(supabase, url, sku, slot = 1) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return null;

  const stagingPath = storagePathFromPublicUrl(raw);
  if (!stagingPath?.startsWith('staging/')) return raw;

  const livePath = buildLiveObjectPath(sku, slot);
  const bucket = supabase.storage.from(BUCKET);

  const { error: moveErr } = await bucket.move(stagingPath, livePath);
  if (moveErr) {
    // Staging file may already have been moved — check if live path exists
    if (await storageObjectExists(supabase, livePath)) {
      return publicUrlForPath(supabase, livePath);
    }
    throw new Error(`Could not promote staging image: ${moveErr.message}`);
  }

  return publicUrlForPath(supabase, livePath);
}

/** Promote or fall back to existing permanent file for a slot URL. */
export async function resolveLiveImageUrl(supabase, url, sku, slot = 1) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return null;
  const stagingPath = storagePathFromPublicUrl(raw);
  if (!stagingPath?.startsWith('staging/')) return raw;
  try {
    return await promoteStagingUrlToLive(supabase, raw, sku, slot);
  } catch {
    const livePath = buildLiveObjectPath(sku, slot);
    if (await storageObjectExists(supabase, livePath)) {
      return publicUrlForPath(supabase, livePath);
    }
    return null;
  }
}

/** Repair a single live row whose image slots still point at staging/*. */
export async function repairSkuLiveStagingUrls(supabase, row) {
  const sku = String(row?.sku || '').trim();
  if (!sku) return { changed: false, patch: null };

  const fields = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
  const patch = { updated_at: new Date().toISOString() };
  let changed = false;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const slot = i + 1;
    const current = String(row[field] || '').split(',')[0].trim();
    if (!current.includes('/staging/')) continue;
    const resolved = await resolveLiveImageUrl(supabase, current, sku, slot);
    if (resolved && resolved !== current) {
      patch[field] = resolved;
      changed = true;
    } else if (!resolved) {
      patch[field] = null;
      changed = true;
    }
  }

  if (!changed) return { changed: false, patch: null };
  const { error } = await supabase.from('website_stock').update(patch).eq('sku', sku);
  if (error) throw new Error(error.message);
  return { changed: true, patch };
}

const IMAGE_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

/** Fix website_stock rows that still point at deleted staging/* URLs. */
export async function repairLiveStagingUrls(supabase) {
  const { data: rows, error } = await supabase
    .from('website_stock')
    .select(`sku, ${IMAGE_FIELDS.join(', ')}`)
    .or(IMAGE_FIELDS.map((f) => `${f}.ilike.%staging/%`).join(','));

  if (error) throw error;

  const repaired = [];
  for (const row of rows || []) {
    const patch = { updated_at: new Date().toISOString() };
    let changed = false;

    for (let i = 0; i < IMAGE_FIELDS.length; i += 1) {
      const field = IMAGE_FIELDS[i];
      const slot = i + 1;
      const current = String(row[field] || '').split(',')[0].trim();
      if (!current.includes('/staging/')) continue;

      const resolved = await resolveLiveImageUrl(supabase, current, row.sku, slot);
      if (resolved !== current) {
        patch[field] = resolved;
        changed = true;
      }
    }

    if (changed) {
      const { error: upErr } = await supabase.from('website_stock').update(patch).eq('sku', row.sku);
      if (upErr) throw new Error(`${row.sku}: ${upErr.message}`);
      repaired.push(row.sku);
    }
  }

  return { repaired, count: repaired.length };
}
export function buildStagingObjectPath(sku, slot = 1) {
  const ym = new Date().toISOString().slice(0, 7);
  const safeSku = String(sku || 'product').replace(/[^a-zA-Z0-9._-]/g, '_');
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `staging/${ym}/${safeSku}-s${slot}-${uid}.jpg`;
}

/** Extract bucket-relative path from a public product-images URL. */
export function storagePathFromPublicUrl(url) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const marker = `/object/public/${BUCKET}/`;
    const idx = u.pathname.indexOf(marker);
    if (idx >= 0) return decodeURIComponent(u.pathname.slice(idx + marker.length));
    const alt = `/storage/v1/object/public/${BUCKET}/`;
    const idx2 = u.pathname.indexOf(alt);
    if (idx2 >= 0) return decodeURIComponent(u.pathname.slice(idx2 + alt.length));
    // R2 / CDN — staging/ prefix in path
    const stagingIdx = u.pathname.indexOf('/staging/');
    if (stagingIdx >= 0) return u.pathname.slice(stagingIdx + 1);
  } catch { /* ignore */ }
  if (raw.includes('/staging/')) {
    const i = raw.indexOf('/staging/');
    return raw.slice(i + 1).split('?')[0];
  }
  return null;
}

export function collectImageUrlsFromRow(row) {
  if (!row) return [];
  return [1, 2, 3, 4]
    .map((s) => String(row[`image_url_${['one', 'two', 'three', 'four'][s - 1]}`] || '').split(',')[0].trim())
    .filter(Boolean);
}

/** Collect staging/* paths still referenced on live website_stock rows. */
export async function collectLiveReferencedStagingPaths(supabase) {
  const { data: rows, error } = await supabase
    .from('website_stock')
    .select(IMAGE_FIELDS.join(', '))
    .or(IMAGE_FIELDS.map((f) => `${f}.ilike.%staging/%`).join(','));
  if (error) throw error;

  const paths = new Set();
  for (const row of rows || []) {
    for (const url of collectImageUrlsFromRow(row)) {
      const path = storagePathFromPublicUrl(url);
      if (path?.startsWith('staging/')) paths.add(path);
    }
  }
  return paths;
}

/** Remove staging/* objects unless still referenced on website_stock. */
export async function removeStagingObjects(supabase, urls = [], { skipLiveReferenced = true } = {}) {
  let paths = [...new Set(
    urls
      .map(storagePathFromPublicUrl)
      .filter((p) => p && p.startsWith('staging/')),
  )];
  if (!paths.length || !supabase) return { removed: 0, skipped: 0 };

  if (skipLiveReferenced) {
    const liveRefs = await collectLiveReferencedStagingPaths(supabase);
    const before = paths.length;
    paths = paths.filter((p) => !liveRefs.has(p));
    const skipped = before - paths.length;
    if (!paths.length) return { removed: 0, skipped };
  }

  try {
    const { error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) console.warn('removeStagingObjects:', error.message);
    return { removed: error ? 0 : paths.length, skipped: 0 };
  } catch (err) {
    console.warn('removeStagingObjects:', err?.message || err);
    return { removed: 0, skipped: 0 };
  }
}
