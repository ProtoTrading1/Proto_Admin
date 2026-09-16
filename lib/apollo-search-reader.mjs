import { paginateSelect } from './apollo-reporting.mjs';

const SOURCES = ['main', 'instore'];
const TYPES = ['search_completed', 'product_view', 'category_view', 'cart_item_added'];
const PAGE_SIZE = 1000;
const MAX_ROWS = 100000;

function validTimestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function validEvent(row) {
  if (!row || typeof row !== 'object' || !SOURCES.includes(row.source) || !TYPES.includes(row.event_type) ||
      typeof row.event_id !== 'string' || !row.event_id.trim() || typeof row.customer_id !== 'string' || !row.customer_id.trim() ||
      typeof row.session_id !== 'string' || !row.session_id.trim() || !validTimestamp(row.occurred_at) ||
      !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return false;
  const p = row.payload;
  if (row.event_type === 'search_completed') return typeof p.original === 'string' && !!p.original.trim() && p.original.length <= 240 &&
    typeof p.normalized === 'string' && !!p.normalized.trim() && p.normalized.length <= 240 && Number.isSafeInteger(p.results_count) && p.results_count >= 0;
  if (row.event_type === 'product_view') return ['parent', 'variant'].includes(p.kind) && typeof p.id === 'string' && !!p.id.trim();
  if (row.event_type === 'category_view') return typeof p.id === 'string' && !!p.id.trim();
  return typeof p.product_id === 'string' && !!p.product_id.trim() && Number.isSafeInteger(p.quantity) && p.quantity > 0;
}

const emptySurface = (source, health) => ({
  source,
  coverage: health?.status || 'unavailable',
  complete: health?.verified === true,
  lastSuccessfulAt: health?.lastSuccessfulAt || null,
  recordedSearches: 0,
  zeroResultSearches: 0,
  productViewsAfterSearch: 0,
  basketAddEventsAfterSearch: 0,
  unattributedProductViews: 0,
  unattributedBasketAddEvents: 0,
  categoriesViewed: 0,
  topTerms: [],
  topProducts: [],
  topCategories: [],
});

/**
 * Read bounded, source-tagged events from the dedicated Apollo database.
 * Search-to-view/cart attribution follows the last completed search in the
 * same authenticated session and surface; it is explicitly not a causal link.
 */
export async function readApolloSearchFunnels({ client, window, sources: sourceHealth = {}, pageSize = PAGE_SIZE, maxRows = MAX_ROWS } = {}) {
  if (!client || typeof client.from !== 'function') throw new TypeError('Apollo activity client is required');
  if (!validTimestamp(window?.start) || !validTimestamp(window?.end) || Date.parse(window.end) <= Date.parse(window.start)) throw new TypeError('Invalid reporting window');
  const rows = await paginateSelect({
    pageSize, maxRows,
    selectPage: ({ from, to }) => client.from('apollo_activity_events')
      .select('event_id,customer_id,session_id,source,event_type,occurred_at,payload')
      .in('event_type', TYPES).gte('occurred_at', window.start).lt('occurred_at', window.end)
      .order('occurred_at', { ascending: true }).order('event_id', { ascending: true }).range(from, to),
  });
  const surfaces = Object.fromEntries(SOURCES.map(source => [source, emptySurface(source, sourceHealth[source])]));
  const terms = Object.fromEntries(SOURCES.map(source => [source, new Map()]));
  const products = Object.fromEntries(SOURCES.map(source => [source, new Map()]));
  const categories = Object.fromEntries(SOURCES.map(source => [source, new Map()]));
  const lastSearch = new Map();
  const eventIds = new Map();
  let invalidRecords = 0;
  for (const row of rows) {
    if (!validEvent(row)) { invalidRecords += 1; continue; }
    const signature = JSON.stringify([row.customer_id, row.session_id, row.source, row.event_type, row.occurred_at, row.payload]);
    if (eventIds.has(row.event_id)) {
      if (eventIds.get(row.event_id) !== signature) invalidRecords += 1;
      continue;
    }
    eventIds.set(row.event_id, signature);
    const target = surfaces[row.source];
    const session = `${row.customer_id}:${row.session_id}:${row.source}`;
    if (row.event_type === 'search_completed') {
      const original = row.payload.original.trim();
      const term = row.payload.normalized.trim().toLocaleLowerCase('en-ZA');
      const entry = terms[row.source].get(term) || { term, searches: 0, zeroResults: 0, originals: new Map(), productViewsAfterSearch: 0, basketAddEventsAfterSearch: 0 };
      entry.searches += 1;
      entry.zeroResults += row.payload.results_count === 0 ? 1 : 0;
      entry.originals.set(original, (entry.originals.get(original) || 0) + 1);
      terms[row.source].set(term, entry);
      target.recordedSearches += 1;
      target.zeroResultSearches += row.payload.results_count === 0 ? 1 : 0;
      lastSearch.set(session, entry);
    } else if (row.event_type === 'product_view') {
      const productKey = `${row.payload.kind}:${row.payload.id}`;
      products[row.source].set(productKey, (products[row.source].get(productKey) || 0) + 1);
      const prior = lastSearch.get(session);
      if (prior) { target.productViewsAfterSearch += 1; prior.productViewsAfterSearch += 1; }
      else target.unattributedProductViews += 1;
    } else if (row.event_type === 'cart_item_added') {
      const prior = lastSearch.get(session);
      if (prior) { target.basketAddEventsAfterSearch += 1; prior.basketAddEventsAfterSearch += 1; }
      else target.unattributedBasketAddEvents += 1;
    } else {
      categories[row.source].set(row.payload.id, (categories[row.source].get(row.payload.id) || 0) + 1);
      target.categoriesViewed += 1;
    }
  }
  for (const source of SOURCES) {
    surfaces[source].topTerms = [...terms[source].values()]
      .map(row => ({ ...row, originals: [...row.originals].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term, count]) => ({ term, count })) }))
      .sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term)).slice(0, 20);
    surfaces[source].topProducts = [...products[source]].map(([product, views]) => ({ product, views }))
      .sort((a, b) => b.views - a.views || a.product.localeCompare(b.product)).slice(0, 20);
    surfaces[source].topCategories = [...categories[source]].map(([category, views]) => ({ category, views }))
      .sort((a, b) => b.views - a.views || a.category.localeCompare(b.category)).slice(0, 20);
    surfaces[source].complete = surfaces[source].complete && invalidRecords === 0 && rows.length < maxRows;
    if (!surfaces[source].complete) surfaces[source].coverage = surfaces[source].coverage === 'complete' ? 'partial' : surfaces[source].coverage;
  }
  return {
    source: 'apollo_activity_events',
    complete: SOURCES.every(source => surfaces[source].complete),
    eventsRead: rows.length,
    invalidRecords,
    attributionMethod: 'Product views and basket additions follow the most recent completed search in the same authenticated session and surface; this is association, not proof of causation.',
    limitations: invalidRecords ? [`${invalidRecords} malformed or conflicting records were excluded.`] : [],
    surfaces,
  };
}

