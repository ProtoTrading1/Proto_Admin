// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApolloBusinessPulse from '../src/components/ApolloBusinessPulse.jsx';

let container; let root; let fail; let denied; let discountScenario;
const source = data => ({ status: 'available', source: 'synthetic', lastSuccessfulAt: '2026-09-12T12:00:00Z', data });
const summary = () => ({ orders: source({ orders: 2, revenue: discountScenario ? 100 : null, revenueKnown: discountScenario, discountsInclVat: discountScenario ? 15 : 0, statuses: { pending: 2 }, products: [], comparison: { status: 'available', window: { start: '2026-09-10T22:00:00.000Z', end: '2026-09-11T22:00:00.000Z', comparisonBasis: 'matching_period_to_date' }, metrics: {
  orderCount: { status: 'available', current: 2, previous: 1, delta: 1, percentChange: 100 }, revenue: { status: 'available', current: 200, previous: 100, delta: 100, percentChange: 100 },
} } }), searches: source({ recordedSearches: 3, topTerms: [], comparison: { status: 'available', window: { start: '2026-09-10T22:00:00.000Z', end: '2026-09-11T22:00:00.000Z', comparisonBasis: 'matching_period_to_date' }, metrics: {
  searches: { status: 'available', current: 3, previous: 2, delta: 1, percentChange: 50 }, zeroResultSearches: { status: 'available', current: 1, previous: 0, delta: 1, percentChange: null },
} } }),
  searchActivity: source({ complete: true, surfaces: { main: { coverage: 'complete', recordedSearches: 1, zeroResultSearches: 1, productViewsAfterSearch: 1, basketAddEventsAfterSearch: 0, topTerms: [{ term: 'bead 861', searches: 1, zeroResults: 1, productViewsAfterSearch: 1, basketAddEventsAfterSearch: 0, originals: [{ term: 'beed 861', count: 1 }] }], topProducts: [], topCategories: [] },
    instore: { coverage: 'complete', recordedSearches: 0, zeroResultSearches: 0, productViewsAfterSearch: 0, basketAddEventsAfterSearch: 0, topTerms: [], topProducts: [], topCategories: [] } } }),
  positill: { status: 'unavailable', data: null, reason: 'Not verified' } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fail = false; denied = false; discountScenario = false;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (denied) return { status: 403, ok: false, json: async () => ({}) };
    if (fail) throw new Error('offline');
    if (String(url).includes('/api/apollo-memory') && options.method === 'POST') return { status: 201, ok: true, json: async () => ({ memory: { key: 'sales.vat-basis', version: 1 } }) };
    if (String(url).includes('/api/apollo-memory')) return { status: 200, ok: true, json: async () => String(url).includes('cursor=next')
      ? { memories: [{ key: 'stock', kind: 'decision', title: 'Approved stock decision', body: 'Preserve source stock.', evidenceRefs: ['decision:stock'], reviewer: 'owner-user', version: 1, state: 'approved' }], nextCursor: null }
      : { memories: [{ key: 'returns', kind: 'definition', title: 'Approved returns policy', body: 'Use the approved returns process.', evidenceRefs: ['policy:returns'], reviewer: 'owner-user', version: 2, state: 'approved' }], nextCursor: 'next' } };
    return { status: 200, ok: true, json: async () => String(url).includes('view=live')
      ? { live: source({ count: 1, freshnessSeconds: 150, customers: [{ customerId: 'test', name: 'Synthetic Customer', basketState: 'not_recorded' }] }) }
      : { ...summary(), ...(discountScenario ? { insights: [{ kind: 'orders', title: 'Website order position' }] } : {}) } };
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(React.createElement(ApolloBusinessPulse))); }
function enter(element, value, type = 'input') {
  Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new Event(type, { bubbles: true }));
}
it('renders the actual live envelope and does not manufacture zero money', async () => {
  await render();
  expect(container.textContent).toContain('Synthetic Customer');
  expect(container.textContent).toContain('Current section: not collected yet.');
  expect(container.textContent).toContain('1 signed-in customers');
  expect(container.textContent).toContain('Unknown order value');
  expect(container.textContent).toContain('Compared with');
  expect(container.textContent).toContain('at the same elapsed point in the previous period');
  expect(container.textContent).toContain('+100%');
  expect(container.textContent).toContain('percentage change unavailable from a zero baseline');
  expect(container.textContent).toContain('basket not recorded');
  expect(container.textContent).toContain('Not verified');
  expect(container.textContent).toContain('Positill report evidence (not verified sales)');
  expect(container.textContent).toContain('No verified decision insight is available for this period.');
  expect(container.textContent).not.toContain('Nothing recorded for this period yet.');
  expect(container.textContent).toContain('Approved returns policy');
  expect(container.textContent).toContain('owner-user');
  expect(container.textContent).toContain('Main website');
  expect(container.textContent).toContain('Instore products');
  expect(container.textContent).toContain('beed 861');
  const memoryButton = [...container.querySelectorAll('button')].find(button => button.textContent.includes('Load more memory records'));
  await act(async () => memoryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(container.textContent).toContain('Approved stock decision');
});
it('authors an owner-only versioned memory record with evidence through the existing review API', async () => {
  await render();
  const form = container.querySelector('form[aria-label="Author Apollo memory"]');
  const key = form.querySelector('input[pattern]');
  const title = form.querySelector('input[maxlength="240"]');
  const textareas = form.querySelectorAll('textarea');
  const selects = form.querySelectorAll('select');
  await act(async () => {
    enter(key, 'sales.vat-basis');
    enter(title, 'Website order VAT basis');
    enter(textareas[0], 'Use recorded VAT-inclusive order totals.');
    enter(textareas[1], 'finance:approved-order-report');
    enter(selects[0], 'decision', 'change');
    enter(selects[1], 'approved', 'change');
  });
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const post = fetch.mock.calls.find(([url, options]) => String(url) === '/api/apollo-memory' && options.method === 'POST');
  expect(JSON.parse(post[1].body)).toMatchObject({ key: 'sales.vat-basis', kind: 'decision', title: 'Website order VAT basis', state: 'approved', expectedVersion: 0, evidenceRefs: ['finance:approved-order-report'] });
  expect(container.textContent).toContain('Revision saved');
});
it('answers a supported question from the loaded report and discloses local-only processing', async () => {
  await render();
  const input = container.querySelector('#apollo-question');
  input.value = 'What were the most popular searches?';
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
  const form = input.closest('form');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain('Ask Apollo');
  expect(container.textContent).toContain('not saved or sent to an AI provider');
  expect(container.textContent).toContain('bead 861');
  expect(container.textContent).toContain('Source: synthetic');
});
it('explains when recorded promotion discounts are included in website order value', async () => {
  discountScenario = true;
  await render();
  expect(container.textContent).toMatch(/R\s*100,00 order value incl\. VAT/);
  expect(container.textContent).toMatch(/Recorded promo discounts of R\s*15,00 are included/);
});
it('labels open order value as pipeline rather than payment-confirmed sales', async () => {
  discountScenario = true;
  await render();
  expect(container.textContent).toContain('This value includes all non-cancelled order stages; it is not payment-confirmed sales.');
  expect(container.textContent).toContain('Order statuses: pending 2.');
  expect(container.textContent).toContain('Order flow · Website order position');
});
it('throttles visibility refresh and separates one-minute and five-minute feeds', async () => {
  await render();
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(fetch).toHaveBeenCalledTimes(4);
  await act(async () => vi.advanceTimersByTimeAsync(240000));
  expect(fetch.mock.calls.filter(([url]) => !String(url).includes('view=live') && !String(url).includes('/api/apollo-memory'))).toHaveLength(2);
});
it('retains old data with a stale warning during outage and clears it on filter change', async () => {
  await render(); fail = true;
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(container.textContent).toContain('previous result');
  expect(container.textContent).toContain('Synthetic Customer');
  const select = container.querySelector('select');
  await act(async () => { select.value = 'week'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).not.toContain('2 recorded orders');
});
it('clears customer and summary details when authorisation expires', async () => {
  await render(); denied = true;
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(container.textContent).toContain('Owner access is required');
  expect(container.textContent).not.toContain('Synthetic Customer');
  expect(container.textContent).not.toContain('2 recorded orders');
});

