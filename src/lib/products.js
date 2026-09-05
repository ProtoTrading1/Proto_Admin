import { adminProductSearch, fuzzyFilter } from './fuzzySearch';
import { labelToSlug, resolveCategoryIdsFromTree, slugToLabel, slugToLabelFromTree, productMatchesNavPath, LEGACY_NAV_ALIASES } from './taxonomy';
import { queryClient } from './queryClient';
import { queryKeys } from './queryKeys';
import { readApiJson } from './apiError.js';
import { enrichMotarroCategoryFields } from '../../lib/mottaro-category.mjs';
import { parseExtraLabels } from '../../lib/taxonomy-match.mjs';

function categoryMainIdMatches(productMainId, targetMainId) {
  if (!targetMainId || !productMainId) return false;
  if (productMainId === targetMainId) return true;
  if (LEGACY_NAV_ALIASES[productMainId] === targetMainId) return true;
  if (LEGACY_NAV_ALIASES[targetMainId] === productMainId) return true;
  return false;
}

function matchesMainCategory(product, mainCategory) {
  if (!mainCategory || mainCategory === 'all') return true;
  if (mainCategory === '__uncategorized__') {
    return !product.category && !product.categoryLabel;
  }
  const productMain = product.categoryPath?.[0] || product.category || '';
  if (categoryMainIdMatches(productMain, mainCategory)) return true;
  const resolvedLabel = slugToLabel(mainCategory);
  return (
    product.category === mainCategory
    || product.categoryLabel === mainCategory
    || product.categoryLabel === resolvedLabel
    || labelToSlug(product.categoryLabel || '') === mainCategory
    || categoryMainIdMatches(labelToSlug(product.categoryLabel || ''), mainCategory)
  );
}

let _loadPromise = null;
let _cache = null;
let _adminLoadPromise = null;
let _adminCache = null;
let _adminCacheGen = 0;

const LS_KEY = 'proto_catalog_v9';
const LS_TTL = 15 * 60 * 1000;

function saveToLocalCache(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ data, ts: Date.now() })); } catch {}
}
function loadFromLocalCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    return (Date.now() - ts < LS_TTL) ? data : null;
  } catch { return null; }
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${url} ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const PAGE_SIZE = 1000;

/** Archived rows created via New Products upload pipeline only */
export const DORMANT_ARCHIVED_BY = 'new-products';
/** Soft-deleted from Product Manager — restorable from Recycle Bin */
export const RECYCLE_ARCHIVED_BY = 'recycle-bin';
/** Auto-archived when source stock hits zero (unless keep_live_when_oos) */
export const AUTO_OOS_ARCHIVED_BY = 'auto-oos';

async function stockAction(body) {
  let res;
  try {
    res = await fetch('/api/stock-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(err?.message?.includes('fetch')
      ? 'Failed to fetch catalogue — server may be busy; try Refresh'
      : (err.message || 'Stock action failed'));
  }
  return readApiJson(res, { fallback: 'Stock action failed' });
}

/** Parse a DB numeric stock field; preserves negatives and zero; null if missing/invalid. */
function readStockField(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/** available_stock (SOH) is primary; fall back to stock_qty. Never coerce negatives to 0. */
export function stockFromRow(row) {
  const available = readStockField(row?.available_stock);
  const raw = readStockField(row?.stock_qty);
  const soh = available !== null ? available : raw;
  return {
    stockOnHand: soh,
    stockQty: soh,
    rawStockQty: raw,
    availableStock: available,
  };
}

function adapt(row, { archived = false, tree = null } = {}) {
  const images = [row.image_url_one, row.image_url_two, row.image_url_three, row.image_url_four].filter(Boolean);
  const subLabels = [
    row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four,
    ...parseExtraLabels(row.subcategory_extra),
  ].filter(Boolean);
  const { categoryId, categoryPath } = resolveCategoryIdsFromTree(row, tree);
  const stock = stockFromRow(row);
  const base = {
    id: row.sku,
    code: row.barcode,
    barcode: row.barcode,
    websiteSku: row.sku,
    sku: row.sku,
    parentSku: null,
    name: row.title,
    title: row.title,
    description: row.original_description || '',
    originalDescription: row.original_description || '',
    packDescription: row.pack_description || '',
    unitsOfIssue: String(row.units_of_issue || '').trim(),
    minQty: Math.max(1, Math.min(9999, Math.floor(Number(row.min_order_qty) || 1))),
    price: Number(row.price) || 0,
    sellPrice: row.sell_price != null ? Number(row.sell_price) : null,
    images,
    image: images[0] || '',
    secondaryImage: images[1] || '',
    imageThree: images[2] || '',
    imageFour: images[3] || '',
    stockQty: stock.stockQty,
    stockOnHand: stock.stockOnHand,
    rawStockQty: stock.rawStockQty,
    availableStock: stock.availableStock,
    colour: '',
    category: categoryId,
    categoryLabel: row.category,
    categoryPath,
    subcategoryLabels: subLabels,
    tags: [],
    badges: [],
    isNew: !!row.is_new_arrival,
    toOrder: !!row.to_order,
    isSpecial: false,
    isArchived: archived,
    sortOrder: 0,
    casePack: '',
    marginCue: '',
    leadTime: '',
    tradeNote: '',
    inStock: stock.stockOnHand !== null ? stock.stockOnHand > 0 : true,
    archivedBy: row.archived_by || null,
    stillLive: !!row.still_live,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    yearlySales: 0,
    supplier: '',
  };
  return enrichMotarroCategoryFields(base, row, tree, categoryPath);
}

async function loadLiveFromDB({ onProgress } = {}) {
  onProgress?.(10);
  const { rows, tree } = await stockAction({ action: 'listLive' });
  onProgress?.(100);
  return (rows || []).map((r) => adapt(r, { tree }));
}

async function loadArchivedFromDB({ dormantOnly = false, catalogOnly = false, recycleOnly = false } = {}) {
  let payload;
  if (recycleOnly) {
    payload = await stockAction({ action: 'listArchived', archivedBy: RECYCLE_ARCHIVED_BY });
  } else if (dormantOnly) {
    payload = await stockAction({ action: 'listArchived', archivedBy: DORMANT_ARCHIVED_BY });
  } else if (catalogOnly) {
    payload = await stockAction({ action: 'listArchived', excludeArchivedBy: [DORMANT_ARCHIVED_BY, RECYCLE_ARCHIVED_BY] });
  } else {
    payload = await stockAction({ action: 'listArchived' });
  }
  const { rows, tree } = payload;
  return (rows || []).map((r) => adapt(r, { archived: true, tree }));
}

function getAllCachedAdmin(onProgress) {
  if (_adminCache) {
    onProgress?.(100);
    return Promise.resolve(_adminCache);
  }
  if (!_adminLoadPromise) {
    const gen = _adminCacheGen;
    _adminLoadPromise = loadLiveFromDB({ onProgress })
      .then(async (all) => {
        if (gen !== _adminCacheGen) {
          _adminLoadPromise = null;
          return getAllCachedAdmin(onProgress);
        }
        _adminCache = all;
        return _adminCache;
      })
      .catch((err) => { _adminLoadPromise = null; throw err; });
  }
  return _adminLoadPromise;
}

function getAllCached() {
  if (!_loadPromise) {
    const local = loadFromLocalCache();
    if (local) {
      _cache = local;
      _loadPromise = Promise.resolve(local);
    } else {
      _loadPromise = fetchJsonWithTimeout('/api/products', 8000)
        .then((products) => {
          _cache = products;
          saveToLocalCache(products);
          return _cache;
        })
        .catch(() => loadLiveFromDB()
          .then((all) => {
            _cache = all;
            saveToLocalCache(_cache);
            return _cache;
          }))
        .catch((err) => {
          _loadPromise = null;
          throw err;
        });
    }
  }
  return _loadPromise;
}

export function invalidateProductCache() {
  _cache = null;
  _loadPromise = null;
  _adminCache = null;
  _adminLoadPromise = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
}

export function invalidateAdminCache() {
  _adminCacheGen += 1;
  _adminCache = null;
  _adminLoadPromise = null;
  _cache = null;
  _loadPromise = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
  queryClient.invalidateQueries({ queryKey: ['catalog'] });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
  queryClient.invalidateQueries({ queryKey: queryKeys.taxonomy() });
}

function applyPathFilter(products, categoryPath) {
  if (!Array.isArray(categoryPath) || !categoryPath.length) return products;
  const tree = _liveTaxonomyTree || [];
  if (tree.length) {
    return products.filter((p) => productMatchesNavPath(p, tree, categoryPath));
  }
  return products.filter((p) => {
    const cp = p.categoryPath || [];
    const depth = Math.min(cp.length, categoryPath.length);
    return depth > 0 && categoryPath.slice(0, depth).every((seg, i) => cp[i] === seg);
  });
}

function applyCategoryFilter(rows, categoryFilter, categoryPathFilter = []) {
  if (categoryPathFilter?.length) {
    if (categoryPathFilter[0] === '__uncategorized__') {
      return rows.filter((p) => !p.category && !p.categoryLabel);
    }
    return applyPathFilter(rows, categoryPathFilter);
  }
  if (!categoryFilter || categoryFilter === 'all') return rows;
  if (categoryFilter === '__uncategorized__') {
    return rows.filter((p) => !p.category && !p.categoryLabel);
  }
  return rows.filter((p) =>
    matchesMainCategory(p, categoryFilter)
    // Match the filter id at any subcategory depth (no fixed-level cap).
    || (p.categoryPath || []).slice(1).includes(categoryFilter)
  );
}

/** Count products with no main category — for the orphans badge / banner. */
export async function fetchUncategorizedCount() {
  const all = await getAllCachedAdmin();
  return all.filter((p) => !p.category && !p.categoryLabel).length;
}

// ─── Public read API ──────────────────────────────────────────────────────────

export async function fetchDistinctCategories() {
  const all = await getAllCachedAdmin();
  return [...new Set(all.map((p) => p.categoryLabel).filter(Boolean))].sort();
}

export async function fetchProducts() {
  return getAllCached();
}

export async function fetchProductPage({
  page = 1,
  pageSize = 60,
  searchQuery = '',
  categoryPath = [],
  sort = 'featured',
} = {}) {
  let products = await getAllCached();
  const hasSearch = Boolean(searchQuery.trim());
  if (!hasSearch) products = applyPathFilter(products, categoryPath);
  products = hasSearch ? fuzzyFilter(products, searchQuery) : products;
  if (sort === 'latest') products = [...products].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = products.length;
  const from = (page - 1) * pageSize;
  return { products: products.slice(from, from + pageSize), total, page, pageSize, hasMore: total > from + pageSize };
}

export async function fetchAllProductsAdmin({ onProgress } = {}) {
  return getAllCachedAdmin(onProgress);
}

/**
 * Server-side replacement search for the fulfilment page.
 *
 * Deliberately not fetchAdminProductsPage: that pulls the whole catalogue into
 * the browser to filter it, which is a heavy download on a warehouse phone and
 * more data than a signed order link should carry.
 */
export async function searchReplacementProducts(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const res = await fetch(`/api/fulfillment-product-search?q=${encodeURIComponent(q)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Product search failed');
  return json.rows || [];
}

export async function fetchCatalogArchiveCount() {
  const rows = await loadArchivedFromDB({ catalogOnly: true });
  return rows.length;
}

export async function fetchAdminProductsPage({
  page = 1,
  pageSize = 50,
  searchQuery = '',
  archived = false,
  recycled = false,
  zeroStockOnly = false,
  categoryFilter = '',
  categoryPathFilter = [],
  onProgress,
} = {}) {
  const showArchived = archived || zeroStockOnly;
  let rows = recycled
    ? await loadArchivedFromDB({ recycleOnly: true })
    : showArchived
      ? await loadArchivedFromDB({ catalogOnly: true })
      : await fetchAllProductsAdmin({ onProgress });
  rows = applyCategoryFilter(rows, categoryFilter, categoryPathFilter);
  const hasSearch = Boolean(searchQuery.trim());
  rows = hasSearch ? fuzzyFilter(rows, searchQuery) : rows;
  rows = hasSearch
    ? rows
    : [...rows].sort((a, b) => (a.categoryLabel || '').localeCompare(b.categoryLabel || '') || a.name.localeCompare(b.name));
  const total = rows.length;
  const from = (page - 1) * pageSize;
  return { rows: rows.slice(from, from + pageSize), total, page, pageSize };
}

export async function fetchProductsByMainCategory(mainCategory, { limit = 10000 } = {}) {
  const all = await getAllCachedAdmin();
  const filtered = mainCategory && mainCategory !== 'all'
    ? all.filter((p) => p.category === mainCategory)
    : all;
  return filtered.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

export async function fetchDormantProducts({ searchQuery = '' } = {}) {
  let dormant = await loadArchivedFromDB({ dormantOnly: true });
  dormant = dormant.filter((p) => !p.stillLive);
  dormant = searchQuery.trim() ? fuzzyFilter(dormant, searchQuery) : dormant;
  dormant.sort((a, b) => a.name.localeCompare(b.name));
  return dormant;
}

export { applyPathFilter };

export async function exportProductsCsv() {
  return fetchAllProductsAdmin();
}

export async function checkStock() { return null; }

// ─── Image helpers ────────────────────────────────────────────────────────────

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const SIZE = 800;
      const scale = Math.min(1, SIZE / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const offsetX = Math.round((SIZE - w) / 2);
      const offsetY = Math.round((SIZE - h) / 2);
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas unavailable'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, offsetX, offsetY, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('Canvas compression failed')); return; }
        resolve(blob);
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}


export async function uploadDormantImage(file) {
  const compressed = await compressImage(file);
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(compressed);
  });

  const res = await fetch('/api/upload-product-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: 'image/jpeg', base64 }),
  });
  const json = await readApiJson(res, { fallback: 'Upload failed' });
  return json.url;
}

// ─── Admin writes ─────────────────────────────────────────────────────────────

let _liveTaxonomyTree = null;

/** Keep in sync with the live taxonomy tree so renames map to correct DB labels. */
export function setLiveTaxonomyTree(tree) {
  _liveTaxonomyTree = Array.isArray(tree) ? tree : null;
}

function pathToWriteFields(categoryPath = []) {
  const label = (slug) => slugToLabelFromTree(slug, _liveTaxonomyTree);
  const category = label(categoryPath[0]) || '';
  const subs = categoryPath.slice(1).map((slug) => label(slug)).filter(Boolean);
  const extra = subs.slice(4);
  return {
    category,
    subcategory_one: subs[0] || category,
    subcategory_two: subs[1] || null,
    subcategory_three: subs[2] || null,
    subcategory_four: subs[3] || null,
    subcategory_extra: extra.length ? JSON.stringify(extra) : null,
  };
}

export async function createProduct(payload) {
  const sku = String(payload.code || payload.websiteSku || '').trim();
  const barcode = String(payload.code || sku).trim();
  const title = String(payload.name || '').trim();
  if (!sku || !barcode || !title) throw new Error('Barcode and product name are required');

  const { category, subcategory_one, subcategory_two, subcategory_three, subcategory_four, subcategory_extra } = pathToWriteFields(payload.categoryPath);
  if (!category) throw new Error('Category is required');

  const row = {
    sku,
    barcode,
    title,
    original_description: String(payload.description || title).trim(),
    image_url_one: payload.image?.trim() || null,
    image_url_two: payload.secondaryImage?.trim() || null,
    image_url_three: payload.imageThree?.trim() || null,
    image_url_four: payload.imageFour?.trim() || null,
    category,
    subcategory_one,
    subcategory_two,
    subcategory_three,
    subcategory_four,
    subcategory_extra,
    price: Number(payload.price) || 0,
    units_of_issue: payload.unitsOfIssue || 'EACH',
    pack_description: payload.packDescription || '',
    min_order_qty: Math.max(1, Math.min(9999, Math.floor(Number(payload.minQty) || 1))),
  };

  await stockAction({ action: 'create', row });
  invalidateProductCache();
  invalidateAdminCache();
}

export async function updateProduct(sku, payload) {
  const body = { websiteSku: sku };

  if (['image', 'secondaryImage', 'imageThree', 'imageFour'].some((key) => payload[key] !== undefined)) {
    body.image = [
      payload.image,
      payload.secondaryImage,
      payload.imageThree,
      payload.imageFour,
    ].map((value) => String(value ?? '').trim()).join(',');
  }
  if (payload.code !== undefined) body.barcode = String(payload.code).trim();
  if (payload.description !== undefined) body.description = payload.description;
  if (payload.packDescription !== undefined) body.packDescription = payload.packDescription;
  if (payload.unitsOfIssue !== undefined) body.unitsOfIssue = payload.unitsOfIssue;
  if (payload.minQty !== undefined) body.minQty = Number(payload.minQty);
  if (payload.name !== undefined) body.title = payload.name;
  if (payload.price !== undefined) body.price = Number(payload.price) || 0;
  // Send node ids, not client-resolved labels — the server resolves them
  // against the live taxonomy (and 409s on a stale path), so a concurrent
  // category rename can't make this move write outdated labels.
  if (payload.categoryPath?.length) body.categoryPathIds = payload.categoryPath;
  if (payload.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = payload.expectedUpdatedAt;
  if (payload.newWebsiteSku !== undefined) body.newWebsiteSku = String(payload.newWebsiteSku).trim();

  if (Object.keys(body).length <= 1 || (Object.keys(body).length === 2 && body.expectedUpdatedAt !== undefined)) {
    invalidateAdminCache();
    return;
  }

  const res = await fetch('/api/update-product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await readApiJson(res, { fallback: 'Update failed' });
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

export async function archiveProduct(sku, shouldArchive = true) {
  // Restore responses can carry syncWarnings (restored but a storefront sync
  // RPC failed) — return the payload so callers can warn the admin.
  const json = shouldArchive
    ? await stockAction({ action: 'archive', sku, by: 'product-manager' })
    : await stockAction({ action: 'unarchive', sku });
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

/** Swap two staged Approval preview slots (1–4) before go-live. */
export async function reorderStagedApprovalImages(sku, fromSlot, toSlot) {
  const res = await fetch('/api/stock-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reorderStagedImages', sku, fromSlot, toSlot }),
  });
  const json = await readApiJson(res, { fallback: 'Failed to reorder staged images' });
  return json;
}

/** Go live from New Products — applies staged image if product is still on site, else unarchives. */
/** Toggle curated New Arrivals placement on the trade site homepage. */
export async function setNewArrival(sku, isNewArrival) {
  await stockAction({ action: 'setNewArrival', sku, isNewArrival: !!isNewArrival });
  invalidateProductCache();
  invalidateAdminCache();
}

/** Toggle "to order": lets a customer order this product even at zero stock. */
export async function setToOrder(sku, toOrder) {
  await stockAction({ action: 'setToOrder', sku, toOrder: !!toOrder });
  invalidateProductCache();
  invalidateAdminCache();
}

/** Load the private incoming-stock state used by Admin and the storefront APIs. */
export async function fetchProductAvailability(sku) {
  return stockAction({ action: 'getProductAvailability', sku });
}

/** Save incoming-container state. This is deliberately separate from To order. */
export async function setProductAvailability(sku, availability) {
  const json = await stockAction({
    action: 'setProductAvailability',
    sku,
    incomingStatus: availability?.incomingStatus || 'none',
    incomingQty: Number(availability?.incomingQty || 0),
    incomingEta: availability?.incomingEta || '',
    shipmentRef: availability?.shipmentRef || '',
    allowPreorder: !!availability?.allowPreorder,
  });
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

export async function recycleProduct(sku, { fromArchive = false } = {}) {
  if (fromArchive) {
    await stockAction({ action: 'recycleFromArchive', sku, archivedBy: RECYCLE_ARCHIVED_BY });
  } else {
    await stockAction({ action: 'archive', sku, by: RECYCLE_ARCHIVED_BY });
  }
  invalidateProductCache();
  invalidateAdminCache();
}

export async function restoreRecycledProduct(sku) {
  const json = await stockAction({ action: 'unarchive', sku });
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

export async function deleteProduct(sku) {
  const res = await fetch('/api/delete-product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ websiteSku: sku }),
  });
  await readApiJson(res, { fallback: 'Delete failed' });
  invalidateAdminCache();
  invalidateProductCache();
}

export async function fetchReorderProducts({
  mainCategory,
  subcategoryId = null,
} = {}) {
  // Reads _adminCache populated by stock-actions listLive (all website_stock rows).
  // Must match /api/catalog?status=live&onlyInStock=false SKU set — see qa-smoke-check.
  let products = await getAllCachedAdmin();

  if (mainCategory && mainCategory !== 'all') {
    products = products.filter((p) => matchesMainCategory(p, mainCategory));
  }
  if (subcategoryId && subcategoryId !== 'all') {
    // Match the subcategory id at any depth (no fixed-level cap).
    products = products.filter((p) => (p.categoryPath || []).slice(1).includes(subcategoryId));
  }

  return products.sort((a, b) => a.name.localeCompare(b.name));
}

/** Short human summary of a server `failed[]` array: first 3 SKUs + a +N tail. */
function summarizeFailed(failed = []) {
  const detail = failed.slice(0, 3).map((f) => `${f.sku}: ${f.error}`).join('; ');
  const suffix = failed.length > 3 ? ` (+${failed.length - 3} more)` : '';
  return `${detail}${suffix}`;
}

export async function bulkMoveProducts({ skus, categoryId, subcategoryId, categoryPathIds }) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'move',
      skus,
      categoryId,
      subcategoryId,
      categoryPathIds,
    }),
  });
  let json;
  try {
    json = await readApiJson(res, { fallback: 'Bulk move failed' });
  } catch (err) {
    if (res.status === 409) {
      const e = new Error(err.message || 'Destination category changed — reload categories and reselect.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
  if (json.failed?.length) {
    const detail = json.failed.slice(0, 3).map((f) => `${f.sku}: ${f.error}`).join('; ');
    const suffix = json.failed.length > 3 ? ` (+${json.failed.length - 3} more)` : '';
    const err = new Error(`${json.moved || 0} moved, ${json.failed.length} failed — ${detail}${suffix}`);
    err.partial = true;
    err.result = json;
    throw err;
  }
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

/**
 * Detach Mottaro products from their primary category (they stay in the
 * Mottaro brand tree). Server skips any non-Mottaro SKUs in the selection.
 */
export async function bulkRemoveFromCategory({ skus }) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'removeFromCategory', skus }),
  });
  const json = await readApiJson(res, { fallback: 'Remove from category failed' });
  if (json.failed?.length) {
    const detail = json.failed.slice(0, 3).map((f) => `${f.sku}: ${f.error}`).join('; ');
    const suffix = json.failed.length > 3 ? ` (+${json.failed.length - 3} more)` : '';
    const err = new Error(`${json.removed || 0} removed, ${json.failed.length} failed — ${detail}${suffix}`);
    err.partial = true;
    err.result = json;
    throw err;
  }
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

/**
 * Batched bulk actions against /api/bulk-products — ONE request per action for
 * the whole selection. The per-SKU loop these replace fired hundreds of
 * requests plus a cache invalidation each, which is what melted the API during
 * large "To recycle" runs.
 */
async function bulkProductsAction(action, skus, { fallback }) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, skus }),
  });
  const json = await readApiJson(res, { fallback });
  // Invalidate BEFORE any throw — a partial success still changed data.
  invalidateProductCache();
  invalidateAdminCache();
  if (json.failed?.length) {
    const okCount = json.recycled ?? json.restored ?? json.deleted ?? json.archived ?? 0;
    throw new Error(`${okCount} ok, ${json.failed.length} failed — ${summarizeFailed(json.failed)}`);
  }
  return json;
}

export function bulkRecycleProducts(skus, { fromArchive = false } = {}) {
  return bulkProductsAction(fromArchive ? 'recycleFromArchive' : 'recycle', skus, { fallback: 'Bulk recycle failed' });
}

export function bulkRestoreRecycledProducts(skus) {
  return bulkProductsAction('unarchive', skus, { fallback: 'Bulk restore failed' });
}

export function bulkDeleteForeverProducts(skus) {
  return bulkProductsAction('delete', skus, { fallback: 'Bulk delete failed' });
}

export async function bulkArchiveProducts(skus) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive', skus }),
  });
  const json = await readApiJson(res, { fallback: 'Bulk archive failed' });
  // Invalidate BEFORE any throw — a partial success still changed data, so the
  // caches must refresh or the succeeded rows keep showing their old state.
  invalidateProductCache();
  invalidateAdminCache();
  if (json.failed?.length) {
    throw new Error(`${json.archived ?? 0} archived, ${json.failed.length} failed — ${summarizeFailed(json.failed)}`);
  }
  return json;
}

export async function bulkUnarchiveProducts(skus) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unarchive', skus }),
  });
  const json = await readApiJson(res, { fallback: 'Bulk restore failed' });
  invalidateProductCache();
  invalidateAdminCache();
  // Restore failures were silently swallowed before — surface them so the
  // admin knows some SKUs are still archived rather than assuming all restored.
  if (json.failed?.length) {
    throw new Error(`${json.restored ?? 0} restored, ${json.failed.length} failed — ${summarizeFailed(json.failed)}`);
  }
  return json;
}

/**
 * Permanently delete a batch of products from BOTH `website_stock` and
 * `archived_products`. Used by the bulk-delete UIs in Product Manager and
 * the Archive section — the action is irreversible, so callers must show
 * an explicit confirmation modal first.
 */
export async function bulkDeleteProducts(skus) {
  const res = await fetch('/api/bulk-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', skus }),
  });
  const json = await readApiJson(res, { fallback: 'Bulk delete failed' });
  invalidateProductCache();
  invalidateAdminCache();
  if (json.failed?.length) {
    throw new Error(`${json.deleted ?? 0} deleted, ${json.failed.length} failed — ${summarizeFailed(json.failed)}`);
  }
  return json;
}

/**
 * Preview the "floater" sweep: live products with no category, or a category
 * that matches no real department (orphaned labels). Returns counts + a sample
 * so the caller can confirm before archiving. Motarro products are excluded.
 */
export async function previewFloaters() {
  const res = await fetch('/api/archive-floaters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'preview' }),
  });
  return readApiJson(res, { fallback: 'Floater preview failed' });
}

/** Archive every floater, tagged archived_by='floater'. Recomputed server-side. */
export async function archiveFloaters() {
  const res = await fetch('/api/archive-floaters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'execute' }),
  });
  const json = await readApiJson(res, { fallback: 'Floater archive failed' });
  invalidateProductCache();
  invalidateAdminCache();
  return json;
}

export async function saveSortOrder() { /* website_stock has no sort_order column */ }
export async function setSpecial() { throw new Error('Not supported'); }
export async function updateSortOrder() { throw new Error('Not supported'); }
export async function bulkUpsertProducts() { throw new Error('Not supported'); }
