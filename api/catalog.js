import { requireOwner } from './_admin-auth.js';
import { loadTaxonomy } from './_taxonomy-utils.js';
import { getStockClient, enrichRowsWithProductStock } from './_stock-client.js';
import {
  adaptCatalogRow,
  applySearchFilter,
  filterByCategoryPath,
  paginateRows,
  resolveCategoryFilters,
  applyCategoryFiltersToQuery,
  categoryPathExceedsFixedColumns,
  isExactlyZeroStock,
  isNegativeStock,
  isPublishableOnWebsite,
} from './_catalog-adapt.js';
import { isMotarroBrowsePath, isMotarroProduct } from './_mottaro-category.js';
import { loadPlacementMapIfEnabled, skusMatchingBrowsePath } from './_placements.js';
import { loadGroupContextIfEnabled } from './_groups.js';
import { normalizeMemberSku } from '../lib/product-groups.mjs';
import {
  isExcelImageArchiveSource,
  filterProductArchiveSection,
  latestExcelImageBatchSource,
  normalizeArchivePrioritySkus,
  prioritizeLatestExcelImageBatch,
  prioritizeRowsBySku,
} from '../lib/archive-priority.mjs';

// maxDuration for this route is set in vercel.json (functions."api/catalog.js").

// Variant grouping: a curated feature merges a handful of SKUs, so the suppress
// list stays small. Above this many, skip the SQL `.not in` (URL-length risk)
// and force the full-scan path, which filters in JS instead.
const GROUP_SUPPRESS_SQL_MAX = 800;

// Only SKUs of this safe shape go into the PostgREST filter string; anything
// with punctuation that could break the `(...)` list is handled by the full-scan
// JS filter instead (see hasUnsafeSuppressSku).
const SAFE_SKU_RE = /^[A-Z0-9_-]+$/;

/** Exclude non-primary group members from a live query (keeps count/range exact). */
function applyGroupSuppression(q, suppressSkus) {
  const safe = (suppressSkus || []).filter((s) => SAFE_SKU_RE.test(s));
  if (safe.length && safe.length <= GROUP_SUPPRESS_SQL_MAX) {
    const quoted = safe.map((s) => `"${s}"`).join(',');
    q = q.not('sku', 'in', `(${quoted})`);
  }
  return q;
}

function hasUnsafeSuppressSku(suppressSkus) {
  return (suppressSkus || []).some((s) => !SAFE_SKU_RE.test(s));
}

const VALID_STATUS = new Set(['live', 'archived', 'new-items', 'recycle']);
const EXCLUDE_ARCHIVED = ['new-products', 'recycle-bin'];
const PAGE_CHUNK = 1000;
const SKU_FETCH_CHUNK = 200;

// The full-scan paths (a search-less "in stock only" toggle, deep category
// paths, Motarro browse, placements) load every matching row into serverless
// memory and refine in JS. That is comfortable at the current catalogue size
// but scales linearly. This is the "real row-count check": once a single scan
// crosses the threshold we log a structured warning (visible in the function
// logs) so the move to a server-side paginated strategy happens before scans
// start timing out — without altering results, count, or pagination today.
const FULL_SCAN_WARN_ROWS = 15000;

function availabilityTableMissing(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /PGRST205|42P01|website_product_availability/i.test(text);
}

/** Attach the private, non-ERP arrival state to rows shown in Product Manager. */
async function enrichRowsWithIncomingAvailability(sb, rows) {
  const skus = [...new Set((rows || []).map((row) => String(row?.sku || '').trim()).filter(Boolean))];
  if (!skus.length) return rows;
  const { data, error } = await sb
    .from('website_product_availability')
    .select('sku, incoming_status, incoming_qty, incoming_eta, allow_preorder')
    .in('sku', skus);
  if (error && availabilityTableMissing(error)) return rows;
  if (error) throw error;
  const bySku = new Map((data || []).map((availability) => [availability.sku, availability]));
  return rows.map((row) => ({ ...row, _incomingAvailability: bySku.get(row.sku) || null }));
}

function warnIfFullScanLarge(count, label) {
  if (count > FULL_SCAN_WARN_ROWS) {
    console.warn(`catalog full-scan large: ${count} rows loaded for ${label} (threshold ${FULL_SCAN_WARN_ROWS}) — consider a server-side paginated path.`);
  }
}

/** Fetch live rows for an explicit sku list, chunked to keep the URL sane. */
async function fetchLiveRowsBySku(sb, skus) {
  const list = [...skus];
  const out = [];
  for (let i = 0; i < list.length; i += SKU_FETCH_CHUNK) {
    const { data, error } = await sb
      .from('website_stock')
      .select('*')
      .in('sku', list.slice(i, i + SKU_FETCH_CHUNK));
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

/**
 * Add products that belong to this category only via an additional placement.
 *
 * The SQL narrow filters on the primary category columns, so a placed product
 * is invisible to it. Rows are re-sorted after the merge because the appended
 * rows arrive outside the original ORDER BY.
 *
 * toOrderOnly must be re-applied here: fetchAllLiveRows pushes it into SQL, but
 * these rows are fetched by sku and would otherwise bypass the filter entirely
 * — the same trap the Mottaro branch already guards against.
 */
export async function appendPlacedRows(sb, rows, placedSkus, sort, { toOrderOnly = false } = {}) {
  if (!placedSkus?.size) return rows;
  const have = new Set(rows.map((r) => r.sku));
  const missing = [...placedSkus].filter((sku) => !have.has(sku));
  if (!missing.length) return rows;

  let fetched = await fetchLiveRowsBySku(sb, missing);
  if (toOrderOnly) fetched = fetched.filter((r) => r.to_order);
  if (!fetched.length) return rows;

  const merged = [...rows, ...fetched];
  merged.sort((a, b) => (sort === 'updated'
    ? String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    : String(a.title || '').localeCompare(String(b.title || ''))));
  return merged;
}

async function fetchAllMotarroRows(sb, { search, categoryPath, tree, sort }) {
  const rows = [];
  let from = 0;
  while (true) {
    let q = sb.from('website_stock').select('*');
    const term = safeSearchTerm(search);
    if (term) {
      q = q.or(`title.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%`);
    } else {
      q = q.or('title.ilike.%motarro%,title.ilike.%mottaro%,title.ilike.%monttaro%');
    }
    if (sort === 'updated') q = q.order('updated_at', { ascending: false });
    else q = q.order('title', { ascending: true });
    q = q.range(from, from + PAGE_CHUNK - 1);
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data || []).filter(isMotarroProduct);
    rows.push(...batch);
    if ((data || []).length < PAGE_CHUNK) break;
    from += PAGE_CHUNK;
  }
  warnIfFullScanLarge(rows.length, 'live/motarro');
  return filterByCategoryPath(rows, categoryPath, tree);
}

async function fetchAllLiveRows(sb, { search, categoryPath, tree, sort, toOrderOnly = false, suppressSkus = [] }) {
  const rows = [];
  let from = 0;
  while (true) {
    let q = sb.from('website_stock').select('*');
    const term = safeSearchTerm(search);
    if (term) {
      q = applyCatalogSearchFilter(q, term);
    }
    q = applyCategoryFiltersToQuery(q, resolveCategoryFilters(tree, categoryPath));
    if (toOrderOnly) q = q.eq('to_order', true);
    q = applyGroupSuppression(q, suppressSkus);
    if (sort === 'updated') q = q.order('updated_at', { ascending: false });
    else q = q.order('title', { ascending: true });
    q = q.range(from, from + PAGE_CHUNK - 1);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_CHUNK) break;
    from += PAGE_CHUNK;
  }
  warnIfFullScanLarge(rows.length, 'live');
  // The SQL filter is exact only within the fixed subcategory columns; a path
  // deeper than subcategory_four is coarsely narrowed by ilike, so refine it to
  // an exact ordered-prefix match in JS (extras-aware via rowCategoryPath).
  if (categoryPathExceedsFixedColumns(categoryPath)) {
    return filterByCategoryPath(rows, categoryPath, tree);
  }
  return rows;
}

async function fetchAllArchivedRows(sb, { archivedBy, excludeBy, sort, search, categoryPath, tree } = {}) {
  const rows = [];
  let from = 0;
  while (true) {
    let q = sb.from('archived_products').select('*');
    if (archivedBy) q = q.eq('archived_by', archivedBy);
    if (excludeBy?.length) {
      const quoted = excludeBy.map((v) => `"${v}"`).join(',');
      q = q.or(`archived_by.is.null,archived_by.not.in.(${quoted})`);
    }
    const term = safeSearchTerm(search);
    if (term) q = applyCatalogSearchFilter(q, term);
    if (Array.isArray(categoryPath) && categoryPath.length && !isMotarroBrowsePath(categoryPath)) {
      q = applyCategoryFiltersToQuery(q, resolveCategoryFilters(tree, categoryPath));
    }
    if (sort === 'archived') {
      q = q
        .order('archived_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false, nullsFirst: false });
    } else if (sort === 'updated') q = q.order('updated_at', { ascending: false });
    else q = q.order('title', { ascending: true });
    q = q.range(from, from + PAGE_CHUNK - 1);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_CHUNK) break;
    from += PAGE_CHUNK;
  }
  warnIfFullScanLarge(rows.length, 'archived');
  // Exact ordered-prefix refine for paths deeper than the fixed columns (the
  // SQL filter only coarsely narrows subcategory_extra via ilike). Motarro
  // browse paths are refined by their own caller.
  if (categoryPathExceedsFixedColumns(categoryPath) && !isMotarroBrowsePath(categoryPath)) {
    return filterByCategoryPath(rows, categoryPath, tree);
  }
  return rows;
}

function parseCategoryPath(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(raw).split('/').filter(Boolean);
  }
}

function parsePrioritySkus(raw) {
  if (!raw) return [];
  try {
    return normalizeArchivePrioritySkus(JSON.parse(raw));
  } catch {
    return normalizeArchivePrioritySkus(String(raw).split(','));
  }
}

function safeSearchTerm(search) {
  return String(search || '').replace(/[%',()\\]/g, ' ').trim();
}

function applyCatalogSearchFilter(q, term) {
  if (!term) return q;
  return q.or([
    `title.ilike.%${term}%`,
    `sku.ilike.%${term}%`,
    `barcode.ilike.%${term}%`,
    `category.ilike.%${term}%`,
    `subcategory_one.ilike.%${term}%`,
    `subcategory_two.ilike.%${term}%`,
    `subcategory_three.ilike.%${term}%`,
    `subcategory_four.ilike.%${term}%`,
    `subcategory_extra.ilike.%${term}%`,
  ].join(','));
}

async function queryLivePaginated(sb, { search, categoryPath, tree, page, pageSize, sort, toOrderOnly = false, suppressSkus = [] }) {
  if (isMotarroBrowsePath(categoryPath)) {
    let rows = await fetchAllMotarroRows(sb, { search, categoryPath, tree, sort });
    if (toOrderOnly) rows = rows.filter((r) => r.to_order);
    if (suppressSkus.length) {
      const s = new Set(suppressSkus);
      rows = rows.filter((r) => !s.has(normalizeMemberSku(r.sku)));
    }
    rows = applySearchFilter(rows, search);
    const pageSlice = paginateRows(rows, page, pageSize);
    return { ...pageSlice, archived: false };
  }
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  let q = sb.from('website_stock').select('*', { count: 'exact' });
  const term = safeSearchTerm(search);
  if (term) {
    q = applyCatalogSearchFilter(q, term);
  }
  q = applyCategoryFiltersToQuery(q, resolveCategoryFilters(tree, categoryPath));
  if (toOrderOnly) q = q.eq('to_order', true);
  q = applyGroupSuppression(q, suppressSkus);
  if (sort === 'updated') q = q.order('updated_at', { ascending: false });
  else q = q.order('title', { ascending: true });
  q = q.range(from, to);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], total: count || 0, page, pageSize, hasMore: (count || 0) > to + 1, archived: false };
}

async function queryArchivedPaginated(sb, { search, categoryPath, tree, page, pageSize, sort, archivedBy, excludeBy }) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  let q = sb.from('archived_products').select('*', { count: 'exact' });
  if (archivedBy) q = q.eq('archived_by', archivedBy);
  const term = safeSearchTerm(search);
  if (term) {
    q = applyCatalogSearchFilter(q, term);
  }
  q = applyCategoryFiltersToQuery(q, resolveCategoryFilters(tree, categoryPath));
  if (excludeBy?.length) {
    const quoted = excludeBy.map((v) => `"${v}"`).join(',');
    q = q.or(`archived_by.is.null,archived_by.not.in.(${quoted})`);
  }
  if (sort === 'archived') {
    q = q
      .order('archived_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false, nullsFirst: false });
  } else if (sort === 'updated') q = q.order('updated_at', { ascending: false });
  else q = q.order('title', { ascending: true });
  q = q.range(from, to);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], total: count || 0, page, pageSize, hasMore: (count || 0) > to + 1, archived: true };
}

async function fetchLiveSkus(sb) {
  const skus = new Set();
  let from = 0;
  while (true) {
    const { data } = await sb.from('website_stock').select('sku').range(from, from + 999);
    for (const r of data || []) skus.add(r.sku);
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return skus;
}

/** Paginated catalogue read for unified Product Manager. */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  if (req.method !== 'GET') return res.status(405).end();

  const status = String(req.query.status || 'live').trim();
  if (!VALID_STATUS.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUS].join(', ')}` });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const search = String(req.query.search || '').trim();
  const categoryPath = parseCategoryPath(req.query.categoryPath);
  const prioritySkus = parsePrioritySkus(req.query.prioritySkus);
  // Archive is an operational review queue: order by the moment a product was
  // actually archived, not by its last edit. Category or description edits can
  // update updated_at and must not jump an older item above a fresh intake.
  const sort = String(req.query.sort || (status === 'archived' ? 'archived' : 'title')).trim();
  const onlyInStock = req.query.onlyInStock === 'true' || req.query.onlyInStock === '1';
  const toOrderOnly = req.query.toOrderOnly === 'true' || req.query.toOrderOnly === '1';

  try {
    const sb = getStockClient();
    const tree = await loadTaxonomy().catch(() => []);
    // null when the feature is off — no extra query, behaviour unchanged.
    const placements = await loadPlacementMapIfEnabled(sb);
    const placedSkus = skusMatchingBrowsePath(placements, categoryPath);
    // Variant grouping (migration 052) — null when catalogGrouping is off, so
    // the live listing is unchanged. Non-primary members are suppressed so a
    // group shows as one card; the primary carries the group roll-up.
    const groupCtx = await loadGroupContextIfEnabled(sb);
    const suppressSet = new Set(groupCtx?.nonPrimaryMemberSkus || []);
    const suppressSkus = [...suppressSet];
    const groupBySku = groupCtx?.bySku || null;
    const groupSizeById = new Map((groupCtx?.groups || []).map((g) => [g.id, (g.members || []).length]));
    // Force the full-scan (JS-filter) path when the suppress list is too big for
    // a SQL `.not in` URL, or contains a SKU we won't safely interpolate.
    const bigSuppression = suppressSet.size > GROUP_SUPPRESS_SQL_MAX || hasUnsafeSuppressSku(suppressSkus);

    let result;
    let stockAlreadyEnriched = false;
    if (status === 'live') {
      const term = safeSearchTerm(search);
      // Paths deeper than the fixed subcategory columns can't get an exact SQL
      // count (subcategory_extra is only coarsely narrowed), so full-scan them
      // and refine + paginate in JS.
      //
      // Products in this category only via an additional placement are also
      // invisible to the SQL count, so they force the full scan too — but only
      // for a category that actually has placements, so the fast path survives
      // everywhere else.
      const useFullScan = onlyInStock || isMotarroBrowsePath(categoryPath) || term
        || categoryPathExceedsFixedColumns(categoryPath) || placedSkus.size > 0 || bigSuppression;
      if (useFullScan) {
        let rows;
        if (isMotarroBrowsePath(categoryPath)) {
          rows = await fetchAllMotarroRows(sb, { search, categoryPath, tree, sort });
          if (toOrderOnly) rows = rows.filter((r) => r.to_order);
        } else {
          rows = await fetchAllLiveRows(sb, { search, categoryPath, tree, sort, toOrderOnly, suppressSkus });
          rows = await appendPlacedRows(sb, rows, placedSkus, sort, { toOrderOnly });
        }
        // Catch-all: the SQL suppression covers fetchAllLiveRows, but Motarro
        // rows, placed rows, and the >MAX big-list case are filtered here.
        if (suppressSet.size) rows = rows.filter((r) => !suppressSet.has(normalizeMemberSku(r.sku)));
        rows = await enrichRowsWithProductStock(sb, rows);
        if (onlyInStock) {
          rows = rows.filter(isPublishableOnWebsite);
        }
        rows = applySearchFilter(rows, search);
        const pageSlice = paginateRows(rows, page, pageSize);
        result = { ...pageSlice, archived: false };
        stockAlreadyEnriched = true;
      } else {
        result = await queryLivePaginated(sb, { search, categoryPath, tree, page, pageSize, sort, toOrderOnly, suppressSkus });
        const rows = await enrichRowsWithProductStock(sb, result.rows);
        result = { ...result, rows };
        stockAlreadyEnriched = true;
      }
    } else if (status === 'recycle') {
      if (categoryPathExceedsFixedColumns(categoryPath)) {
        // Deep path — full-scan + JS refine so the count is exact.
        let rows = await fetchAllArchivedRows(sb, {
          archivedBy: 'recycle-bin', sort, search, categoryPath, tree,
        });
        rows = await enrichRowsWithProductStock(sb, rows);
        rows = applySearchFilter(rows, search);
        const pageSlice = paginateRows(rows, page, pageSize);
        result = { ...pageSlice, archived: true };
        stockAlreadyEnriched = true;
      } else {
        result = await queryArchivedPaginated(sb, {
          search, categoryPath, tree, page, pageSize, sort, archivedBy: 'recycle-bin',
        });
      }
    } else if (status === 'archived') {
      const stockFilter = String(req.query.stockFilter || 'archived').trim();
      const archivedSource = String(req.query.archivedSource || 'all').trim();
      const archiveSection = String(req.query.archiveSection || 'older').trim();
      if (stockFilter === 'negative') {
        // Live products with negative ERP stock only — zeros excluded.
        let rows = await fetchAllLiveRows(sb, { search, categoryPath, tree, sort });
        rows = await enrichRowsWithProductStock(sb, rows);
        rows = rows.filter(isNegativeStock);
        const pageSlice = paginateRows(rows, page, pageSize);
        result = { ...pageSlice, archived: false, archiveView: 'negative-live' };
        stockAlreadyEnriched = true;
      } else {
        const archiveFetch = archivedSource === 'nutstore'
          ? { archivedBy: 'nutstore', sort }
          : archivedSource === 'other'
            ? { excludeBy: [...EXCLUDE_ARCHIVED, 'nutstore'], sort }
            : { excludeBy: EXCLUDE_ARCHIVED, sort };
        let rows = await fetchAllArchivedRows(sb, {
          ...archiveFetch,
          search,
          categoryPath,
          tree,
        });
        rows = await enrichRowsWithProductStock(sb, rows);
        // Hide zero-stock rows only when the ERP link is live and reports zero.
        // Placeholders without an ERP row (e.g. Nutstore-only) stay visible so
        // admins can edit their code and re-link them.
        rows = rows.filter((r) => {
          if (r.stockLinked === false) return true;
          if (r.archived_by === 'nutstore' || isExcelImageArchiveSource(r.archived_by)) return true;
          return !isExactlyZeroStock(r);
        });
        if (isMotarroBrowsePath(categoryPath)) {
          rows = filterByCategoryPath(rows, categoryPath, tree);
        }
        rows = applySearchFilter(rows, search);
        rows = filterProductArchiveSection(rows, archiveSection);
        // The server-recorded batch is authoritative across independent tabs.
        // Keep the browser hint only as a fallback for older unmarked imports.
        const pinnedBatchSource = latestExcelImageBatchSource(rows);
        rows = pinnedBatchSource
          ? prioritizeLatestExcelImageBatch(rows)
          : prioritizeRowsBySku(rows, prioritySkus);
        const pinnedBatchCount = pinnedBatchSource
          ? rows.filter((row) => String(row?.archived_by || '').trim() === pinnedBatchSource).length
          : 0;
        const pageSlice = paginateRows(rows, page, pageSize);
        result = { ...pageSlice, archived: true, archiveView: 'archived', pinnedBatchCount };
        stockAlreadyEnriched = true;
      }
    } else if (status === 'new-items') {
      const liveSkus = await fetchLiveSkus(sb);
      const allRows = await fetchAllArchivedRows(sb, { archivedBy: 'new-products', sort });
      let rows = allRows.filter((r) => !liveSkus.has(r.sku));
      rows = filterByCategoryPath(rows, categoryPath, tree);
      rows = applySearchFilter(rows, search);
      const pageSlice = paginateRows(rows, page, pageSize);
      result = { ...pageSlice, archived: true };
    }

    const needsStock = status === 'live' || status === 'archived' || status === 'recycle'
      || status === 'new-items';
    let enriched = result.rows;
    if (needsStock && enriched.length && !stockAlreadyEnriched) {
      enriched = await enrichRowsWithProductStock(sb, enriched, { includePrice: status === 'new-items' });
    }
    if (status === 'live' && enriched.length) {
      enriched = await enrichRowsWithIncomingAvailability(sb, enriched);
    }

    const adapted = enriched.map((r) => {
      const row = adaptCatalogRow(r, tree, {
        archived: result.archived,
        placementPaths: placements ? (placements.get(r.sku) || []) : null,
      });
      if (groupBySku) {
        const gi = groupBySku.get(normalizeMemberSku(r.sku));
        // Suppressed members are already filtered out on the live path, so any
        // surviving grouped row is a primary — badge it for the admin UI.
        if (gi) {
          row.variantGroup = {
            groupId: gi.groupId,
            title: gi.groupTitle,
            isPrimary: gi.isPrimary,
            primarySku: gi.groupPrimarySku,
            variantCount: groupSizeById.get(gi.groupId) || null,
          };
        }
      }
      return row;
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      rows: adapted,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      status,
      archiveView: result.archiveView || (status === 'archived' ? 'archived' : null),
      pinnedBatchCount: result.pinnedBatchCount || 0,
    });
  } catch (err) {
    console.error('catalog:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Catalog fetch failed' });
  }
}
