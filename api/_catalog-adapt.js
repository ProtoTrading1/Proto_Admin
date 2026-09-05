import { labelToSlug, resolveCategoryIds } from './_taxonomy-utils.js';
import {
  enrichMotarroCategoryFields,
  filterRowsByMotarroPath,
  isMotarroBrowsePath,
  isMotarroProduct,
} from './_mottaro-category.js';
import { escapeIlikePattern, parseExtraLabels } from '../lib/taxonomy-match.mjs';
import { mergeCategoryPaths } from './_placements.js';
import { isExactlyZeroStock, isPublishableOnWebsite, isNegativeStock } from '../lib/catalog-stock.mjs';

const SUB_FIELDS = ['subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four'];

/**
 * True when a browse path descends past the fixed subcategory columns (i.e.
 * into `subcategory_extra` territory). SQL `.eq()` filters can only match the
 * fixed columns exactly; deeper paths need the JS `filterByCategoryPath`
 * refine for an exact result, so callers that need an exact COUNT must route
 * these through the full-scan path rather than a paginated SQL count.
 */
export function categoryPathExceedsFixedColumns(categoryPath) {
  return Array.isArray(categoryPath) && categoryPath.length > SUB_FIELDS.length + 1;
}

/** Stable taxonomy node ids for a DB row (falls back to slug-of-label when orphaned). */
export function rowCategoryPath(row, tree = null) {
  const { categoryPath } = resolveCategoryIds(row, tree);
  if (categoryPath.length) return categoryPath;
  const parts = [row.category, ...SUB_FIELDS.map((f) => row[f]), ...parseExtraLabels(row.subcategory_extra)].filter(Boolean);
  return parts.map(labelToSlug);
}

/** Resolve category path slugs to DB column filters using taxonomy tree. */
export function resolveCategoryFilters(tree, categoryPath) {
  if (!Array.isArray(categoryPath) || !categoryPath.length) return {};
  if (categoryPath[0] === '__uncategorized__') {
    return { uncategorized: true };
  }
  const main = (tree || []).find((c) => c.id === categoryPath[0] || labelToSlug(c.label) === categoryPath[0]);
  if (!main) return {};
  const filters = { category: main.label };
  let nodes = main.children || [];
  for (let i = 1; i < categoryPath.length; i += 1) {
    const slug = categoryPath[i];
    const node = nodes.find((n) => n.id === slug || labelToSlug(n.label) === slug);
    if (!node) break;
    if (i - 1 < SUB_FIELDS.length) {
      filters[SUB_FIELDS[i - 1]] = node.label;
    } else {
      // Depth beyond subcategory_four lives in the JSON `subcategory_extra`
      // column. SQL can only coarsely narrow it (ilike on the deepest label);
      // the exact ordered-prefix match is enforced by filterByCategoryPath in
      // JS. Only the deepest label is needed for the coarse SQL narrow.
      filters.subcategoryExtraDeepest = node.label;
    }
    nodes = node.children || [];
  }
  return filters;
}

export function applyCategoryFiltersToQuery(q, filters) {
  if (filters.uncategorized) return q.or('category.is.null,category.eq.');
  if (filters.category) q = q.eq('category', filters.category);
  if (filters.subcategory_one) q = q.eq('subcategory_one', filters.subcategory_one);
  if (filters.subcategory_two) q = q.eq('subcategory_two', filters.subcategory_two);
  if (filters.subcategory_three) q = q.eq('subcategory_three', filters.subcategory_three);
  if (filters.subcategory_four) q = q.eq('subcategory_four', filters.subcategory_four);
  if (filters.subcategoryExtraDeepest) {
    q = q.ilike('subcategory_extra', `%${escapeIlikePattern(filters.subcategoryExtraDeepest)}%`);
  }
  return q;
}

/** Filter rows whose category path starts with the given taxonomy id prefix. */
export function filterByCategoryPath(rows, categoryPath, tree = null) {
  if (!Array.isArray(categoryPath) || !categoryPath.length) return rows;
  if (isMotarroBrowsePath(categoryPath)) {
    return filterRowsByMotarroPath(rows, categoryPath, tree);
  }
  if (categoryPath[0] === '__uncategorized__') {
    return rows.filter((r) => !String(r.category || '').trim());
  }
  return rows.filter((r) => {
    const cp = rowCategoryPath(r, tree);
    // Product must be at same depth or deeper than the selected category — prevents
    // loose parent-only rows (e.g. School & Office with no sub) appearing in every child.
    return cp.length >= categoryPath.length
      && categoryPath.every((seg, i) => cp[i] === seg);
  });
}

export function applySearchFilter(rows, search) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return rows;
  const safe = q.replace(/[%',()]/g, ' ').trim();
  if (!safe) return rows;
  return rows.filter((r) => {
    const hay = [r.sku, r.barcode, r.title, r.category, ...SUB_FIELDS.map((f) => r[f]), ...parseExtraLabels(r.subcategory_extra)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(safe);
  });
}

/**
 * Adapt a DB row for the admin catalogue.
 *
 * `placementPaths` are the product's ADDITIONAL locations (migration 049).
 * categoryPath stays the primary so every existing reader is unaffected;
 * categoryPaths carries the full set, merged with any Mottaro path.
 */
export function adaptCatalogRow(row, tree, { archived = false, placementPaths = null } = {}) {
  const images = [row.image_url_one, row.image_url_two, row.image_url_three, row.image_url_four].filter(Boolean);
  const subLabels = [...SUB_FIELDS.map((f) => row[f]), ...parseExtraLabels(row.subcategory_extra)].filter(Boolean);
  const { categoryId, categoryPath } = resolveCategoryIds(row, tree);
  const soh = row.available_stock ?? row.stock_qty;
  const stockNum = soh !== null && soh !== undefined && soh !== ''
    ? Number(soh)
    : 0;
  const incomingStatus = String(row?._incomingAvailability?.incoming_status || 'none');
  const incomingQty = Number(row?._incomingAvailability?.incoming_qty || 0);
  const base = {
    id: row.sku,
    sku: row.sku,
    barcode: row.barcode,
    code: row.barcode,
    websiteSku: row.sku,
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
    stockQty: stockNum,
    stockOnHand: stockNum,
    availableStock: row.available_stock != null ? Number(row.available_stock) : null,
    category: categoryId,
    categoryLabel: row.category,
    categoryPath,
    subcategoryLabels: subLabels,
    toOrder: !!row.to_order,
    incomingStatus,
    incomingQty: Number.isFinite(incomingQty) && incomingQty > 0 ? incomingQty : 0,
    stockAvailable: ['landed_awaiting_grv', 'partially_received'].includes(incomingStatus) && incomingQty > 0,
    isNew: !!row.is_new_arrival,
    isArchived: archived,
    archivedBy: row.archived_by || null,
    stillLive: !!row.still_live,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    movedAt: row.moved_at || null,
    movedFrom: row.moved_from || null,
    movedTo: row.moved_to || null,
    liveImages: archived && row._live ? [
      row._live.image_url_one,
      row._live.image_url_two,
      row._live.image_url_three,
      row._live.image_url_four,
    ].map((u) => String(u || '').split(',')[0].trim() || null) : null,
    stagedImages: archived ? images : null,
    changedSlots: row._changedSlots || null,
    stockReady: row._stockReady ?? null,
    stockError: row._stockError ?? null,
    stockLinked: row.stockLinked !== false,
  };
  const enriched = enrichMotarroCategoryFields(base, row, tree, categoryPath);
  const extras = Array.isArray(placementPaths) ? placementPaths : [];
  return {
    ...enriched,
    // Primary first, then the Mottaro path, then placements — deduped, so a
    // placement equal to the primary does not render the product twice.
    categoryPaths: mergeCategoryPaths(categoryPath, [...(enriched.categoryPaths || []), ...extras]),
    placementPaths: extras,
  };
}

export function paginateRows(rows, page, pageSize) {
  const total = rows.length;
  const from = (page - 1) * pageSize;
  return {
    rows: rows.slice(from, from + pageSize),
    total,
    page,
    pageSize,
    hasMore: total > from + pageSize,
  };
}

/** SOH from enriched row: available_stock first, then stock_qty. Null if unknown. */
export function readStockOnHand(row) {
  const read = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  const available = read(row?.available_stock);
  const raw = read(row?.stock_qty);
  return available !== null ? available : raw;
}

export function isZeroOrNegativeStock(row) {
  const soh = readStockOnHand(row);
  return soh === null ? false : soh <= 0;
}

export { isExactlyZeroStock, isPublishableOnWebsite, isNegativeStock };
