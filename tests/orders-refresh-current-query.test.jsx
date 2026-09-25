/* @vitest-environment happy-dom */
import fs from 'node:fs';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the actual small refresh effect, not a reimplementation of its
// dependency list. This isolates it from AdminPage's unrelated API effects.
const source = fs.readFileSync('src/pages/AdminPage.jsx', 'utf8');
const marker = source.indexOf('const refresh = () => { if (document.visibilityState');
const start = source.lastIndexOf('useEffect(() => {', marker);
const end = source.indexOf('\n  // Remember the expanded order', marker);
const registerEffect = new Function('useEffect', 'activeSection', 'orderTab', 'orderPage', 'orderPageSize', 'orderSearchDebounced', 'loadOrders', source.slice(start, end));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, load;
function Harness({ section = 'orders', tab = 'new', page = 1, size = 10, search = '' }) {
  registerEffect(useEffect, section, tab, page, size, search, () => load(`${tab}|${page}|${size}|${search}`));
  return null;
}
async function render(props = {}) { await act(async () => root.render(<Harness {...props} />)); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  load = vi.fn(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Orders automatic refresh follows the current query', () => {
  it('focus refreshes All orders after switching from New', async () => {
    await render(); await render({ tab: 'all' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(load.mock.calls).toEqual([['all|1|10|']]);
  });
  it('timer refreshes the current page, size and search exactly once', async () => {
    await render(); await render({ tab: 'paid', page: 2, size: 25, search: 'SYNTHETIC' });
    await act(async () => vi.advanceTimersByTime(30000));
    expect(load.mock.calls).toEqual([['paid|2|25|SYNTHETIC']]);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('does not refresh hidden pages or sections other than Orders', async () => {
    await render(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(30000); });
    expect(load).not.toHaveBeenCalled();
    await render({ section: 'site-content' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up the focus handler on leaving Orders', async () => {
    await render({ tab: 'all' }); await render({ section: 'site-content' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(load).not.toHaveBeenCalled();
  });
});
