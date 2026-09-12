// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ApolloBusinessPulse from '../src/components/ApolloBusinessPulse.jsx';

let container; let root; let fail; let denied;
const source = data => ({ status: 'available', source: 'synthetic', lastSuccessfulAt: '2026-09-12T12:00:00Z', data });
const summary = () => ({ orders: source({ orders: 2, revenue: null, products: [] }), searches: source({ recordedSearches: 3, topTerms: [] }),
  positill: { status: 'unavailable', data: null, reason: 'Not verified' } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fail = false; denied = false;
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (denied) return { status: 403, ok: false, json: async () => ({}) };
    if (fail) throw new Error('offline');
    return { status: 200, ok: true, json: async () => String(url).includes('view=live')
      ? { live: source({ count: 1, freshnessSeconds: 150, customers: [{ customerId: 'test', name: 'Synthetic Customer', basketState: 'not_recorded' }] }) }
      : summary() };
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(React.createElement(ApolloBusinessPulse))); }
it('renders the actual live envelope and does not manufacture zero money', async () => {
  await render();
  expect(container.textContent).toContain('Synthetic Customer');
  expect(container.textContent).toContain('1 signed-in customers');
  expect(container.textContent).toContain('Unknown order value');
  expect(container.textContent).toContain('basket not recorded');
  expect(container.textContent).toContain('Not verified');
});
it('throttles visibility refresh and separates one-minute and five-minute feeds', async () => {
  await render();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(240000));
  expect(fetch.mock.calls.filter(([url]) => !String(url).includes('view=live'))).toHaveLength(2);
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
