import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { readPositillEvidence } from '../lib/apollo-positill-evidence.mjs';

const window = { kind: 'day', start: '2026-09-11T22:00:00.000Z', end: '2026-09-12T12:00:00.000Z', timezone: 'Africa/Johannesburg', periodToDate: true };
const checkedAt = '2026-09-12T12:00:00.000Z';

test('does not call the existing bridge while evidence is disabled', async () => {
  let calls = 0;
  const result = await readPositillEvidence({ window, checkedAt, fetchTopSellers: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.data, null);
});

test('rejects windows whose semantics cannot be expressed by the existing bridge', async () => {
  let calls = 0;
  const result = await readPositillEvidence({ window: { ...window, kind: 'week' }, checkedAt, enabled: true, fetchTopSellers: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.match(result.reason, /week, month, or custom/i);
});

test('does not show the bridge today snapshot for a past or non-current day window', async () => {
  let calls = 0;
  const past = { ...window, start: '2026-09-10T22:00:00.000Z', end: '2026-09-11T22:00:00.000Z' };
  const result = await readPositillEvidence({ window: past, checkedAt, enabled: true, fetchTopSellers: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
});

test('returns raw line evidence without claiming sales, VAT, credits, or reconciliation', async () => {
  const result = await readPositillEvidence({ window, checkedAt, enabled: true, fetchTopSellers: async (input) => {
    assert.deepEqual(input, { period: 'today', scope: 'top_sellers', limit: 20 });
    return { dataSource: 'erp_sql', periodLabel: 'today (Positill · SAST)', invoiceHeaderCount: 4,
      items: [{ code: ' 86a ', title: 'Widget', totalQty: '3', totalValue: '19.75' }] };
  } });
  assert.equal(result.status, 'available');
  assert.equal(result.complete, false);
  assert.deepEqual(result.data.topLineItems, [{ code: '86A', title: 'Widget', quantity: 3, rawTotal: 19.75 }]);
  assert.equal(result.data.taxBasis, 'unknown');
  assert.equal(result.data.creditNoteTreatment, 'unknown');
  assert.equal(result.data.websiteReconciliation, 'unavailable');
  assert.match(result.reason, /not use as verified sales/i);
});

test('makes a bridge failure unavailable rather than returning zeros or diagnostics', async () => {
  const result = await readPositillEvidence({ window, checkedAt, enabled: true, fetchTopSellers: async () => { throw new Error('private bridge error'); } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.data, null);
  assert.ok(!JSON.stringify(result).includes('private bridge'));
});

