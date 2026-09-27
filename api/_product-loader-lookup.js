import { codeLookupCandidates, baseCodeToken } from '../lib/code-normalize.mjs';
import {
  loaderPriceSourceLabel,
  loaderPriceUsesCachedData,
  looksLikeExVatPrice,
  resolveLoaderCustomerPrice,
} from '../lib/catalogue-price.mjs';
import { resolveProductByCode } from './_sql-provider.js';
import { toSqlPreview } from './_sql-stmast.js';
import { parseLoaderFilename } from './_product-loader-filename.js';
import { fetchProductLookupMap, findProductBySku } from './_sku-match.js';
import { inferExplicitPiecePackFromDescription, normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';

export { parseLoaderFilename } from './_product-loader-filename.js';

export const SLOT_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
export const WEBSITE_STOCK_COLS =
  'sku, title, price, original_description, category, subcategory_one, subcategory_two, '
  + 'subcategory_three, subcategory_four, '
  + 'units_of_issue, pack_description, '
  + 'image_url_one, image_url_two, image_url_three, image_url_four, barcode, updated_at, stock_qty, available_stock';

function slugPattern(term) {
  return String(term || '').trim().replace(/[-_]+/g, '%');
}

export async function lookupWebsiteStockExact(sb, code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return null;
  const { data } = await sb
    .from('website_stock')
    .select(WEBSITE_STOCK_COLS)
    .eq('sku', upper)
    .maybeSingle();
  return data || null;
}

async function lookupWebsiteStock(sb, code, displayCode) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return { row: null, matchedBy: null };

  const bySku = await lookupWebsiteStockExact(sb, upper);
  if (bySku) return { row: bySku, matchedBy: 'code' };

  const byBarcode = await sb.from('website_stock').select(WEBSITE_STOCK_COLS).eq('barcode', upper).maybeSingle();
  if (byBarcode.data) return { row: byBarcode.data, matchedBy: 'barcode' };

  const slug = slugPattern(displayCode || code);
  if (slug.length >= 2) {
    const { data } = await sb
      .from('website_stock')
      .select(WEBSITE_STOCK_COLS)
      .ilike('title', `%${slug}%`)
      .limit(1)
      .maybeSingle();
    if (data) return { row: data, matchedBy: 'title' };
  }

  return { row: null, matchedBy: null };
}

async function lookupWebsiteStockStrict(sb, code) {
  const row = await lookupWebsiteStockExact(sb, code);
  return { row, matchedBy: row ? 'code' : null };
}

async function lookupPositill(sb, code, displayCode) {
  const upper = String(code || '').trim().toUpperCase();
  const resolved = upper
    ? await resolveProductByCode(upper).catch(() => ({ product: null, dataSource: null, bridgeAttempted: true }))
    : { product: null, dataSource: null, bridgeAttempted: false };
  if (resolved.product) {
    return {
      sqlRow: toSqlPreview(resolved.product),
      matchedBy: resolved.dataSource === 'erp_sql' ? 'positill_code' : 'positill_cache_code',
      positillSource: resolved.dataSource,
      bridgeAttempted: resolved.bridgeAttempted,
    };
  }

  const slug = slugPattern(displayCode || code);
  if (slug.length >= 2) {
    const { data } = await sb
      .from('stmast_cache')
      .select('code, descr, price_a, onhand, booked, dept')
      .ilike('descr', `%${slug}%`)
      .limit(1)
      .maybeSingle();

    if (data) {
      const onhand = Number(data.onhand) || 0;
      const booked = Number(data.booked) || 0;
      return {
        sqlRow: toSqlPreview({
          code: String(data.code || '').trim(),
          title: String(data.descr ?? '').trim(),
          price: Number(data.price_a) || 0,
          onhand,
          booked,
          available: onhand - booked,
          dept: data.dept || '',
        }),
        matchedBy: 'positill_title',
        positillSource: 'stmast_cache',
        bridgeAttempted: resolved.bridgeAttempted,
      };
    }
  }

  return {
    sqlRow: null,
    matchedBy: null,
    positillSource: null,
    bridgeAttempted: resolved.bridgeAttempted,
  };
}

async function lookupPositillStrict(sb, code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return { sqlRow: null, matchedBy: null, positillSource: null, bridgeAttempted: false };
  const resolved = await resolveProductByCode(upper)
    .catch(() => ({ product: null, dataSource: null, bridgeAttempted: true }));
  // A landed shipment may override zero current stock with its received-stock
  // Excel, but it may never use a cached Positill record for sellable data.
  if (resolved.dataSource === 'erp_sql' && resolved.product) {
    return {
      sqlRow: toSqlPreview(resolved.product),
      matchedBy: 'positill_code',
      positillSource: 'erp_sql',
      bridgeAttempted: resolved.bridgeAttempted,
    };
  }
  return {
    sqlRow: null,
    matchedBy: null,
    positillSource: resolved.dataSource || null,
    bridgeAttempted: resolved.bridgeAttempted,
  };
}

export function resolveWebsiteStatus({ websiteRow, sqlRow, dormantSkus, code }) {
  const sku = String(websiteRow?.sku || code || '').trim().toUpperCase();
  if (websiteRow?.sku) return 'live';
  if (sku && dormantSkus?.has(sku)) return 'dormant';
  if (sqlRow) return 'new';
  return 'not_found';
}

function cachedLookup(cache, key, lookup) {
  if (!cache) return lookup();
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(lookup));
  return cache.get(key);
}

export async function resolveProductLoaderMatch(sb, {
  code,
  fullCode = null,
  displayCode,
  imageSlot = 1,
  dormantSkus = null,
  parseError = null,
  strictExact = false,
  lookupCache = null,
}) {
  if (parseError) {
    return {
      code: '',
      displayCode: displayCode || '',
      title: '',
      price: 0,
      imageSlot: Math.min(4, Math.max(1, Number(imageSlot) || 1)),
      sqlRow: null,
      websiteRow: null,
      warnings: ['invalid_filename'],
      matchedBy: null,
      canPublish: false,
      websiteStatus: 'not_found',
      department: '',
      category: '',
      stockOnHand: null,
      parseError,
    };
  }

  const clampedSlot = Math.min(4, Math.max(1, Number(imageSlot) || 1));
  // Exact-product-match-first: if the file's FULL code (slot suffix kept)
  // differs from the stripped code, try it as slot 1 of a real variant SKU
  // (e.g. MKT822662.2) BEFORE interpreting the .2 as a slot suffix.
  const upperFull = String(fullCode || '').trim().toUpperCase();
  const upperCode = String(code || '').trim().toUpperCase();
  const attempts = [];
  if (strictExact) {
    // A landed shipment may never fall back from its filename's exact SKU to
    // a shorter family code, a related colour, or a slot interpretation.
    // That would pair the received quantity and image with the wrong product.
    const exactCode = upperFull || upperCode;
    if (exactCode) attempts.push({ candidate: exactCode, slot: clampedSlot });
  } else {
    if (upperFull && upperFull !== upperCode) {
      attempts.push({ candidate: fullCode, slot: 1 });
    }
    for (const candidate of codeLookupCandidates(code)) {
      attempts.push({ candidate, slot: clampedSlot });
    }
  }

  let websiteRow = null;
  let webMatch = null;
  let sqlRow = null;
  let positillMatch = null;
  let positillSource = null;
  let bridgeAttempted = false;
  let matchedCandidate = null;
  let matchedSlot = clampedSlot;

  for (const attempt of attempts) {
    const [webResult, positill] = await Promise.all([
      strictExact
        ? cachedLookup(lookupCache, `website:${attempt.candidate}`, () => lookupWebsiteStockStrict(sb, attempt.candidate))
        : lookupWebsiteStock(sb, attempt.candidate, displayCode),
      strictExact
        ? cachedLookup(lookupCache, `positill:${attempt.candidate}`, () => lookupPositillStrict(sb, attempt.candidate))
        : lookupPositill(sb, attempt.candidate, displayCode),
    ]);
    if (webResult.row || positill.sqlRow) {
      websiteRow = webResult.row;
      webMatch = webResult.matchedBy;
      sqlRow = positill.sqlRow;
      positillMatch = positill.matchedBy;
      positillSource = positill.positillSource;
      bridgeAttempted = positill.bridgeAttempted;
      matchedCandidate = attempt.candidate;
      matchedSlot = attempt.slot;
      break;
    }
  }

  // Second pass ("double reasoning"): if NOTHING resolved with the full code —
  // including any variant suffix after a "-", a "." or brackets — fall back to
  // the bare base/number code rather than keeping the whole SKU. A matched
  // product always wins first, so this only affects the not-found case.
  const unmatchedFallback = baseCodeToken(code) || code;
  const effectiveCode = websiteRow?.sku || sqlRow?.code || matchedCandidate || unmatchedFallback;
  const hasCatalogMatch = Boolean(websiteRow || sqlRow);
  const rawTitle = hasCatalogMatch
    ? String(sqlRow?.title || websiteRow?.title || '').trim()
    : '';
  const upperEffective = String(effectiveCode || '').trim().toUpperCase();
  const title = rawTitle && rawTitle.toUpperCase() !== upperEffective ? rawTitle : '';
  const productCode = String(
    sqlRow?.code || websiteRow?.barcode || effectiveCode || '',
  ).trim().toUpperCase();
  const productLookup = productCode
    // Unit of issue is canonical backend data.  `pack_description` is an
    // optional legacy field and must not make the entire product lookup fail.
    ? await cachedLookup(lookupCache, `product:${productCode}`, () =>
      fetchProductLookupMap(sb, [productCode], 'sku, sell_price, units_of_issue').catch(() => new Map()))
    : new Map();
  const productRow = findProductBySku(productLookup, productCode);
  // The live Positill row is authoritative for new landed stock. The product
  // mirror is retained only as a compatibility fallback for older bridge rows.
  const explicitDescriptionUnit = inferExplicitPiecePackFromDescription(sqlRow?.title || websiteRow?.title || '');
  const canonicalUnitRaw = String(
    sqlRow?.units_of_issue || productRow?.units_of_issue || websiteRow?.units_of_issue || explicitDescriptionUnit || '',
  ).trim();
  const rawPositillPrice = Number(sqlRow?.price) || 0;
  const resolvedPrice = resolveLoaderCustomerPrice({
    productSellPrice: productRow?.sell_price,
    websitePrice: websiteRow?.price,
    positillPrice: rawPositillPrice,
    positillSource,
  });
  const price = resolvedPrice.price;
  // The effective slot reflects the winning attempt: an exact full-code hit
  // publishes to slot 1; otherwise the stripped slot from the filename.
  const slot = matchedSlot;
  const warnings = [];
  const websiteStatus = resolveWebsiteStatus({
    websiteRow,
    sqlRow,
    dormantSkus,
    code: effectiveCode,
  });

  if (!websiteRow && !sqlRow) warnings.push('not_in_catalog');
  if (websiteRow?.[SLOT_FIELDS[slot - 1]]) warnings.push('image_exists');
  if (!price) warnings.push('price_zero');
  if (!websiteRow && loaderPriceUsesCachedData(resolvedPrice.source)) warnings.push('price_source_cached');
  // The July 2026 import captured EX-VAT prices where the incl-VAT ones
  // belong, and ~91 products published at the wrong price with nothing
  // flagging it. Hold anything matching that fingerprint for review.
  if (looksLikeExVatPrice(price)) warnings.push('price_suspect_ex_vat');
  const available = sqlRow?.available ?? websiteRow?.available_stock ?? websiteRow?.stock_qty;
  if (available != null && Number(available) <= 0) warnings.push('low_stock');
  if (!websiteRow?.category && !sqlRow) warnings.push('needs_category');

  const needsReview = warnings.some((w) => ['price_zero', 'price_source_cached', 'price_suspect_ex_vat', 'image_exists', 'low_stock', 'needs_category'].includes(w));

  return {
    code: effectiveCode,
    displayCode: displayCode || code,
    title: hasCatalogMatch ? title : '',
    price,
    priceSource: resolvedPrice.source,
    priceSourceLabel: loaderPriceSourceLabel(resolvedPrice.source),
    positillSource,
    bridgeAttempted,
    erpPriceExVat: rawPositillPrice || null,
    productSellPrice: productRow?.sell_price != null ? Number(productRow.sell_price) : null,
    // Landed shipments must use this canonical product record. A website
    // fallback is deliberately not enough: the item may not yet be live.
    canonicalSellingUnitKnown: Boolean(canonicalUnitRaw),
    sellingUnitSource: sqlRow?.units_of_issue
      ? 'positill_live'
      : productRow?.units_of_issue
        ? 'positill_backend'
        : websiteRow?.units_of_issue
          ? 'website_backend'
          : explicitDescriptionUnit
            ? 'positill_description_explicit'
            : 'missing',
    // Do not manufacture EACH for strict landed-shipment review. It receives
    // physical pieces, so an unresolved selling unit is deliberately blank
    // and the row is ineligible until Positill data resolves it.
    unitsOfIssue: canonicalUnitRaw
      ? normalizeUnitsOfIssue(canonicalUnitRaw)
      : (strictExact ? '' : 'EACH'),
    packDescription: String(websiteRow?.pack_description || '').trim(),
    imageSlot: slot,
    sqlRow,
    websiteRow,
    warnings,
    matchedBy: webMatch || positillMatch || null,
    canPublish: Boolean(websiteRow || sqlRow) && !parseError,
    websiteStatus,
    department: String(sqlRow?.dept || '').trim(),
    category: String(websiteRow?.category || '').trim(),
    stockOnHand: available,
    needsReview,
    parseError: null,
  };
}

export async function fetchDormantSkuSet(sb) {
  const skus = new Set();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('archived_products')
      .select('sku')
      .eq('archived_by', 'new-products')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data || []) skus.add(row.sku);
    if ((data || []).length < PAGE) break;
    from += PAGE;
  }
  return skus;
}

// A folder needs the archive state of its own SKUs, not the entire archive.
// Keep requests small enough for PostgREST URL limits and fail closed on error.
export async function fetchDormantSkuSetForCodes(sb, codes) {
  const skus = new Set();
  const unique = [...new Set(codes.map((code) => String(code || '').trim().toUpperCase()).filter(Boolean))];
  for (let from = 0; from < unique.length; from += 100) {
    const { data, error } = await sb.from('archived_products').select('sku')
      .eq('archived_by', 'new-products').in('sku', unique.slice(from, from + 100));
    if (error) throw error;
    for (const row of data || []) skus.add(String(row.sku || '').trim().toUpperCase());
  }
  return skus;
}

// Short-lived module cache — dormant queue changes slowly; refreshing every
// 60s is plenty for the Product Loader lookup path and keeps concurrent
// admins from thrashing archived_products with full-table scans.
let _dormantCache = null;
let _dormantCacheAt = 0;
const DORMANT_TTL_MS = 60_000;

export function invalidateDormantSkuCache() {
  _dormantCache = null;
  _dormantCacheAt = 0;
}

export async function getCachedDormantSkuSet(sb) {
  const now = Date.now();
  if (_dormantCache && now - _dormantCacheAt < DORMANT_TTL_MS) return _dormantCache;
  const fresh = await fetchDormantSkuSet(sb);
  _dormantCache = fresh;
  _dormantCacheAt = now;
  return fresh;
}

export function classifyBatchItem(item) {
  if (!item.canPublish || item.parseError) return 'not_found';
  if (item.needsReview || item.warnings?.length) return 'needs_review';
  return 'ready';
}
