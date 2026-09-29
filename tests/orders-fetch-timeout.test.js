import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOrdersPage } from '../src/lib/orders.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('admin order list timeout', () => {
  it('stops a stalled request with a retryable message', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOrdersPage({ tab: 'all' });
    const failure = expect(pending).rejects.toThrow('Orders took too long to load. Please try again.');
    await vi.advanceTimersByTimeAsync(25000);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
