import { describe, expect, it } from 'vitest';
import { readApolloSearchFunnels } from '../lib/apollo-search-reader.mjs';

const start = '2026-09-14T10:00:00.000Z';
const end = '2026-09-14T11:00:00.000Z';
const coverage = Object.fromEntries(['main', 'instore'].map(source => [source, { status: 'complete', verified: true, lastSuccessfulAt: end }]));
function event(id, source, event_type, seconds, payload, session_id = `${source}-session`) {
  return { event_id: id, customer_id: `${source}-customer`, session_id, source, event_type,
    occurred_at: new Date(Date.parse(start) + seconds * 1000).toISOString(), payload };
}
function client(rows) {
  return { from: () => {
    const filters = [];
    const q = { select: () => q, in: (key, values) => { filters.push(row => values.includes(row[key])); return q; },
      gte: (key, value) => { filters.push(row => row[key] >= value); return q; },
      lt: (key, value) => { filters.push(row => row[key] < value); return q; },
      order: () => q, range: (from, to) => Promise.resolve({ data: rows.filter(row => filters.every(filter => filter(row))).slice(from, to + 1), error: null }) };
    return q;
  } };
}

describe('Apollo Main/Instore search funnels', () => {
  it('keeps surfaces separate and preserves original spellings, zero results and same-session follow-on events', async () => {
    const rows = [
      event('m-search', 'main', 'search_completed', 1, { original: 'beed 861', normalized: 'bead 861', results_count: 0 }),
      event('m-view', 'main', 'product_view', 4, { kind: 'variant', id: 'SKU-1', parent_id: 'P-1' }),
      event('m-cart', 'main', 'cart_item_added', 9, { product_id: 'SKU-1', quantity: 2 }),
      event('i-search', 'instore', 'search_completed', 2, { original: 'metal bead', normalized: 'metal bead', results_count: 7 }),
      event('i-view', 'instore', 'product_view', 8, { kind: 'parent', id: 'P-2' }),
      event('i-category', 'instore', 'category_view', 12, { id: 'jewellery' }),
      event('unattributed-cart', 'main', 'cart_item_added', 15, { product_id: 'SKU-2', quantity: 1 }, 'other-session'),
    ];
    const result = await readApolloSearchFunnels({ client: client(rows), window: { start, end }, sources: coverage });
    expect(result).toMatchObject({ complete: true, eventsRead: 7, invalidRecords: 0 });
    expect(result.surfaces.main).toMatchObject({ recordedSearches: 1, zeroResultSearches: 1, productViewsAfterSearch: 1,
      basketAddEventsAfterSearch: 1, unattributedBasketAddEvents: 1, coverage: 'complete' });
    expect(result.surfaces.main.topTerms[0]).toMatchObject({ term: 'bead 861', searches: 1, zeroResults: 1,
      originals: [{ term: 'beed 861', count: 1 }], productViewsAfterSearch: 1, basketAddEventsAfterSearch: 1 });
    expect(result.surfaces.instore).toMatchObject({ recordedSearches: 1, zeroResultSearches: 0, productViewsAfterSearch: 1,
      categoriesViewed: 1, coverage: 'complete' });
    expect(result.surfaces.instore.topTerms[0].term).toBe('metal bead');
    expect(result.attributionMethod).toMatch(/association, not proof of causation/);
  });

  it('marks unknown coverage partial and fails closed on malformed events or truncated reads', async () => {
    const rows = [event('ok', 'main', 'search_completed', 5, { original: 'bracelet', normalized: 'bracelet', results_count: 1 }),
      { ...event('bad', 'main', 'search_completed', 6, { original: 'bad', normalized: 'bad', results_count: -1 }) }];
    const result = await readApolloSearchFunnels({ client: client(rows), window: { start, end }, sources: { main: coverage.main } });
    expect(result.complete).toBe(false);
    expect(result.invalidRecords).toBe(1);
    expect(result.surfaces.main.coverage).toBe('partial');
    expect(result.surfaces.instore.coverage).toBe('unavailable');
  });
});

