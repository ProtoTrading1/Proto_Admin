import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createPulseHandler } from '../api/apollo-pulse.js';

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function database(tables = {}, failures = [], missingCurrentSection = false) {
  const calls = [];
  return { calls, from(table) {
    calls.push(table);
    const filters = [];
    let selectedColumns = '';
    const q = { select(columns = '') { selectedColumns = columns; return q; }, order() { return q; },
      gte(k, v) { filters.push(r => r[k] >= v); return q; },
      lte(k, v) { filters.push(r => r[k] <= v); return q; },
      lt(k, v) { filters.push(r => r[k] < v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      range(from, to) { return Promise.resolve(failures.includes(table)
        ? { error: { message: 'Private DB diagnostics must not escape' } }
        : (missingCurrentSection && table === 'customer_presence' && selectedColumns.includes('current_section')
          ? { error: { message: 'column customer_presence.current_section does not exist' } }
          : { data: (tables[table] || []).filter(r => filters.every(f => f(r))).slice(from, to + 1), error: null })); } };
    return q;
  } };
}
async function run({ db = database(), overrides = {}, query = {}, method = 'GET' } = {}) {
  const res = response();
  const handler = createPulseHandler({ verify: async () => ({ email: 'owner@example.test' }), owner: () => true,
    enabled: () => true, client: () => db, now: () => new Date('2026-09-12T12:00:00Z'), ...overrides });
  await handler({ method, headers: {}, query }, res);
  return res;
}
test('owner authentication precedes all reporting reads', async () => {
  const db = database();
  assert.equal((await run({ db, overrides: { verify: async () => null } })).code, 401);
  assert.equal((await run({ db, overrides: { owner: () => false } })).code, 403);
  assert.deepEqual(db.calls, []);
});
test('feature switch defaults disabled and endpoint rejects writes', async () => {
  assert.equal((await run({ overrides: { enabled: () => false } })).code, 404);
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await run({ method })).code, 405);
});
test('valid empty reads are distinct from failed and unconnected sources', async () => {
  const r = await run();
  assert.equal(r.body.orders.status, 'available');
  assert.equal(r.body.orders.data.orders, 0);
  assert.equal(r.body.positill.data, null);
  assert.equal(r.body.positill.status, 'unavailable');
  assert.equal(r.body.activeTime.data, null);
  assert.equal(r.headers['Cache-Control'], 'private, no-store');
  const failed = await run({ db: database({}, ['orders']) });
  assert.equal(failed.body.orders.data, null);
  assert.equal(failed.body.searches.status, 'available');
  assert.ok(!JSON.stringify(failed.body).includes('Private DB'));
});
test('activity reporting reads only the isolated Apollo database after owner access', async () => {
  let activityReads = 0;
  const isolated = { marker: 'isolated-activity-db' };
  let activityDb;
  const r = await run({ overrides: {
    activityEnabled: () => true,
    activityClient: () => isolated,
    activityReader: async ({ client, window }) => { activityReads += 1; activityDb = client; assert.equal(window.kind, 'day'); return { complete: true, status: 'available', activeSeconds: 42, activeCustomers: 1, averageSecondsPerCustomer: 42, sources: {} }; },
  } });
  assert.equal(activityReads, 1);
  assert.equal(r.body.activeTime.status, 'available');
  assert.equal(r.body.activeTime.complete, true);
  assert.equal(r.body.activeTime.data.activeSeconds, 42);
  assert.equal(activityDb, isolated);
  assert.equal(r.body.insights.find(row => row.kind === 'engagement').source, 'apollo_activity_events');

  const blocked = await run({ overrides: {
    verify: async () => null,
    activityEnabled: () => true,
    activityClient: () => { throw new Error('must not be called'); },
  } });
  assert.equal(blocked.code, 401);
});
test('activity totals are unavailable until the isolated collector is explicitly enabled', async () => {
  const r = await run();
  assert.equal(r.body.activeTime.status, 'unavailable');
  assert.equal(r.body.activeTime.data, null);
  assert.match(r.body.activeTime.reason, /disabled until collection coverage is verified/i);
});
test('partial activity coverage never becomes a period engagement insight', async () => {
  const r = await run({ overrides: { activityEnabled: () => true, activityClient: () => ({}),
    activityReader: async () => ({ complete: false, status: 'partial', activeSeconds: null, activeCustomers: 1, averageSecondsPerCustomer: null, eventsRead: 1, sources: {} }) } });
  assert.equal(r.body.activeTime.status, 'partial');
  assert.equal(r.body.activeTime.data.activeSeconds, null);
  assert.ok(!r.body.insights.some(row => row.kind === 'engagement'));
});
test('source-separated search reporting uses the isolated event store and preserves search details', async () => {
  const isolated = database({ apollo_activity_events: [
    { event_id: 's1', customer_id: 'customer', session_id: 'session', source: 'instore', event_type: 'search_completed',
      occurred_at: '2026-09-12T11:00:00.000Z', payload: { original: 'beed 861', normalized: 'bead 861', results_count: 0 } },
  ] });
  const portal = database();
  const r = await run({ db: portal, overrides: {
    activityEnabled: () => true,
    activityClient: () => isolated,
    activityReader: async () => ({ complete: true, sources: { main: { status: 'complete', verified: true }, instore: { status: 'complete', verified: true } } }),
  } });
  assert.equal(r.body.searchActivity.status, 'available');
  assert.equal(r.body.searchActivity.data.surfaces.instore.recordedSearches, 1);
  assert.equal(r.body.searchActivity.data.surfaces.instore.topTerms[0].originals[0].term, 'beed 861');
  assert.ok(isolated.calls.includes('apollo_activity_events'));
  assert.ok(!portal.calls.includes('apollo_activity_events'));
});
test('Apollo adds joined priorities without presenting website orders as Positill sales', async () => {
  const r = await run({ db: database({
    orders: [{ id: 'o1', status: 'pending', total_ex_vat: 100, created_at: '2026-09-12T11:00:00.000Z',
      final_items: [{ variant_sku: 'sku1', qty: 1, unitPrice: 100 }] }],
    search_analytics: [{ id: 's1', search_term: 'diary', results_found: 0, created_at: '2026-09-12T11:00:00.000Z' }],
  }) });
  assert.equal(r.body.insights[0].kind, 'opportunity');
  assert.match(r.body.insights.find(row => row.kind === 'orders').detail, /not payment-confirmed sales or Positill sales/);
  assert.ok(!r.body.insights.some(row => row.kind === 'engagement'));
});
test('period comparisons use matching SAST ranges and expose changes only when both periods are complete', async () => {
  const r = await run({ db: database({
    orders: [
      { id: 'current-order', status: 'pending', total_ex_vat: 150, created_at: '2026-09-12T11:00:00.000Z', final_items: [{ variant_sku: 'SKU', qty: 1, unitPrice: 150 }] },
      { id: 'prior-order', status: 'pending', total_ex_vat: 100, created_at: '2026-09-11T11:00:00.000Z', final_items: [{ variant_sku: 'SKU', qty: 1, unitPrice: 100 }] },
    ],
    search_analytics: [
      { id: 'current-search', search_term: 'beads', results_found: 0, created_at: '2026-09-12T11:00:00.000Z' },
      { id: 'prior-search', search_term: 'beads', results_found: 2, created_at: '2026-09-11T11:00:00.000Z' },
    ],
  }) });
  assert.equal(r.body.orders.data.comparison.status, 'available');
  assert.deepEqual(r.body.orders.data.comparison.metrics.revenue, { status: 'available', current: 150, previous: 100, delta: 50, percentChange: 50 });
  assert.deepEqual(r.body.searches.data.comparison.metrics.zeroResultSearches, { status: 'available', current: 1, previous: 0, delta: 1, percentChange: null });
  assert.equal(r.body.orders.data.comparison.window.start, '2026-09-10T22:00:00.000Z');
  assert.equal(r.body.orders.data.comparison.window.end, '2026-09-11T12:00:00.000Z');
  assert.equal(r.body.window.periodToDate, true);
  assert.equal(r.body.orders.periodClosed, false);
});
test('period comparison does not use incomplete prior-period totals', async () => {
  const r = await run({ db: database({ orders: [
    { id: 'current-order', status: 'pending', total_ex_vat: 150, created_at: '2026-09-12T11:00:00.000Z', final_items: [{ variant_sku: 'SKU', qty: 1, unitPrice: 150 }] },
    { id: 'prior-order', status: 'pending', total_ex_vat: null, created_at: '2026-09-11T11:00:00.000Z', final_items: [{ variant_sku: 'SKU', qty: 1, unitPrice: 100 }] },
  ] }) });
  assert.equal(r.body.orders.data.comparison.status, 'unavailable');
  assert.match(r.body.orders.data.comparison.reason, /complete result/i);
});
test('basket risk is an aggregated current snapshot and is never labelled as sales', async () => {
  const r = await run({ db: database({ customer_account_carts: [
    { customer_id: 'a', activity_at: Date.parse('2026-08-01T12:00:00.000Z'), items: [{ product: { sku: 'X', name: 'Item', price: 12.5 }, qty: 2 }] },
  ] }) });
  assert.equal(r.body.baskets.data.openBaskets, 1);
  assert.equal(r.body.baskets.data.valueInclVat, 25);
  assert.equal(r.body.baskets.data.coldBaskets, 1);
  assert.match(r.body.insights.find(row => row.kind === 'basket').detail, /not sales/);
});
test('Apollo only exposes existing Positill data through the configured authenticated bridge', async () => {
  let calls = 0;
  const r = await run({ overrides: { positillEvidenceEnabled: () => true, positillBridgeReady: () => true, positillFetcher: async () => {
    calls += 1;
    return { dataSource: 'erp_sql', periodLabel: 'today', invoiceHeaderCount: 1,
      items: [{ code: '86', title: 'Item', totalQty: 2, totalValue: 10 }] };
  } } });
  assert.equal(calls, 1);
  assert.equal(r.body.positill.status, 'available');
  assert.equal(r.body.positill.complete, false);
  assert.equal(r.body.positill.data.taxBasis, 'unknown');
  assert.match(r.body.positill.reason, /not use as verified sales/i);
});
test('Apollo refuses the legacy direct SQL fallback when the authenticated bridge is not configured', async () => {
  let calls = 0;
  const r = await run({ overrides: { positillEvidenceEnabled: () => true, positillBridgeReady: () => false, positillFetcher: async () => { calls += 1; } } });
  assert.equal(calls, 0);
  assert.equal(r.body.positill.status, 'unavailable');
  assert.equal(r.body.positill.data, null);
  assert.match(r.body.positill.reason, /authenticated existing bridge report/i);
});
test('SAST window filters at the database and legacy search surface remains unknown', async () => {
  const db = database({ search_analytics: [
    { id: '1', created_at: '2026-09-11T22:00:00.000Z', search_term: 'beeds', normalized_search_term: 'beads', results_found: 0 },
    { id: '2', created_at: '2026-09-11T21:59:59.000Z', search_term: 'old', results_found: 3 },
  ] });
  const r = await run({ db });
  assert.equal(r.body.searches.data.recordedSearches, 1);
  assert.equal(r.body.searches.data.topTerms[0].zeroResults, 1);
  assert.equal(r.body.searches.data.surface, 'legacy_unspecified');
  assert.equal(r.body.searches.asOf, '2026-09-12T12:00:00.000Z');
  assert.equal(r.body.searches.periodClosed, false);
});
test('malformed search rows preserve valid evidence but mark the source incomplete', async () => {
  const r = await run({ db: database({ search_analytics: [
    { id: '1', created_at: '2026-09-11T22:00:00.000Z', search_term: 'beads', results_found: 0 },
    { id: '2', created_at: '2026-09-11T23:00:00.000Z', search_term: null, results_found: 2 },
    { id: '3', created_at: '2026-09-12T00:00:00.000Z', search_term: 'paint', results_found: null },
  ] }) });
  assert.equal(r.body.searches.status, 'partial');
  assert.equal(r.body.searches.complete, false);
  assert.equal(r.body.searches.data.recordedSearches, 3);
  assert.equal(r.body.searches.data.invalidRecords, 2);
  assert.deepEqual(r.body.searches.data.topTerms, [{ term: 'beads', searches: 1, zeroResults: 1,
    clicks: 0, cartAdds: 0, orders: 0, orderValue: 0 }]);
});
test('live shoppers join names and carts only for currently active customer ids', async () => {
  const r = await run({ query: { view: 'live' }, db: database({
    customer_presence: [{ customer_id: 'a', last_seen_at: '2026-09-12T11:59:00Z', current_section: 'instore' }, { customer_id: 'old', last_seen_at: '2026-09-12T11:50:00Z', current_section: 'main' }],
    customers: [{ id: 'a', name: 'Test owner' }, { id: 'old', name: 'Old' }],
    customer_account_carts: [{ customer_id: 'a', items: [{ product: { sku: 'X', name: 'Test', price: 12.5 }, qty: 2 }], activity_at: 1789210000000 }],
  }) });
  assert.equal(r.body.live.data.count, 1);
  assert.equal(r.body.live.data.customers[0].basket.value, 25);
  assert.equal(r.body.live.data.customers[0].currentSection, 'instore');
});
test('live shopper view remains available against a portal schema before current-section migration', async () => {
  const r = await run({ query: { view: 'live' }, db: database({
    customer_presence: [{ customer_id: 'a', last_seen_at: '2026-09-12T11:59:00Z' }],
  }, [], true) });
  assert.equal(r.body.live.status, 'available');
  assert.equal(r.body.live.data.customers[0].currentSection, null);
});
test('missing cart is not misrepresented as a verified empty basket', async () => {
  const r = await run({ query: { view: 'live' }, db: database({ customer_presence: [{ customer_id: 'a', last_seen_at: '2026-09-12T11:59:00Z' }] }) });
  assert.equal(r.body.live.data.customers[0].basketState, 'not_recorded');
});
test('invalid and excessive periods fail before data access', async () => {
  for (const query of [{ period: 'custom', start: '2026-02-30', end: '2026-03-04' },
    { period: 'custom', start: '2020-01-01', end: '2026-01-01' }, { view: 'private' }]) {
    const db = database();
    assert.equal((await run({ db, query })).code, 400);
    assert.deepEqual(db.calls, []);
  }
});

