import { afterEach, describe, expect, it, vi } from 'vitest';
import { askApolloOperations } from '../src/lib/apolloOperations.js';
afterEach(() => vi.unstubAllGlobals());
describe('Apollo requested date range honesty', () => {
  it.each(['Sales on 2026-08-30', 'Orders on 30/08/2026', 'How were sales yesterday?', 'Customers viewing in the last 14 days', 'Sales in the last 48 hours'])('does not silently substitute 30 days for %s', async (question) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(askApolloOperations(question)).rejects.toThrow('no substitute report was requested');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['Orders today', 1, 'today'], ['Sales in the last 1 day', 1, undefined], ['Sales in the last 7 days', 7, undefined], ['Sales in the last 30 days', 30, undefined], ['Sales in the last 90 days', 90, undefined]])('preserves supported window %s', async (question, days, key) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { summary: 'Synthetic answer', findings: [], limitations: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await askApolloOperations(question);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.periodDays).toBe(days);
    expect(body.periodKey).toBe(key);
  });
});
