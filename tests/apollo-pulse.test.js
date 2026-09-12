import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createPulseHandler } from '../api/apollo-pulse.js';

function response() {
  return { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function database(tables = {}, failures = []) {
  const calls = [];
  return { calls, from(table) {
    calls.push(table);
    const filters = [];
    const q = { select() { return q; }, order() { return q; },
      gte(k, v) { filters.push(r => r[k] >= v); return q; },
      lte(k, v) { filters.push(r => r[k] <= v); return q; },
      lt(k, v) { filters.push(r => r[k] < v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      range(from, to) { return Promise.resolve(failures.includes(table)
        ? { error: { message: 'Private DB diagnostics must not escape' } }
        : { data: (tables[table] || []).filter(r => filters.every(f => f(r))).slice(from, to + 1), error: null }); } };
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
test('activity reporting only uses the dedicated Apollo client after owner access', async () => {
  let activityReads = 0;
  const activity = { complete: false, estimated: true, activeSeconds: 0, sources: {
    main: { status: 'unavailable' }, instore: { status: 'unavailable' },
  } };
  const r = await run({ overrides: {
    activityClient: () => ({ isolated: true }),
    activityReader: async ({ client, window }) => { activityReads += 1; assert.equal(client.isolated, true); assert.equal(window.kind, 'day'); return activity; },
  } });
  assert.equal(activityReads, 1);
  assert.equal(r.body.activeTime.status, 'available');
  assert.equal(r.body.activeTime.complete, false);
  assert.equal(r.body.activeTime.data.estimated, true);

  const blocked = await run({ overrides: {
    verify: async () => null,
    activityClient: () => { throw new Error('must not be called'); },
  } });
  assert.equal(blocked.code, 401);
});
test('missing dedicated activity configuration is unavailable rather than zero', async () => {
  const r = await run({ overrides: { activityClient: () => { throw new Error('not configured'); } } });
  assert.equal(r.body.activeTime.status, 'unavailable');
  assert.equal(r.body.activeTime.data, null);
  assert.match(r.body.activeTime.reason, /could not be read/i);
});
test('Apollo only exposes existing Positill data as explicitly enabled raw evidence', async () => {
  let calls = 0;
  const r = await run({ overrides: { positillEvidenceEnabled: () => true, positillFetcher: async () => {
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
  assert.equal(r.body.searches.status, 'available');
  assert.equal(r.body.searches.complete, false);
  assert.equal(r.body.searches.data.recordedSearches, 3);
  assert.equal(r.body.searches.data.invalidRecords, 2);
  assert.deepEqual(r.body.searches.data.topTerms, [{ term: 'beads', searches: 1, zeroResults: 1 }]);
});
test('live shoppers join names and carts only for currently active customer ids', async () => {
  const r = await run({ query: { view: 'live' }, db: database({
    customer_presence: [{ customer_id: 'a', last_seen_at: '2026-09-12T11:59:00Z' }, { customer_id: 'old', last_seen_at: '2026-09-12T11:50:00Z' }],
    customers: [{ id: 'a', name: 'Test owner' }, { id: 'old', name: 'Old' }],
    customer_account_carts: [{ customer_id: 'a', items: [{ product: { sku: 'X', name: 'Test', price: 12.5 }, qty: 2 }], activity_at: 1789210000000 }],
  }) });
  assert.equal(r.body.live.data.count, 1);
  assert.equal(r.body.live.data.customers[0].basket.value, 25);
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
