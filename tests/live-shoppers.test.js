import { describe, expect, it, vi } from 'vitest';
import { FRESHNESS_SECONDS } from '../api/live-shoppers.js';

/**
 * The live shopper count is a contract between two repos: the storefront
 * heartbeats every HEARTBEAT_MS, and this window decides how long that beat
 * keeps a customer visible. These lock down the parts that would silently
 * produce a wrong number rather than an error.
 */

/** Minimal Supabase double capturing the filter the handler builds. */
function fakeSupabase(result) {
  const calls = [];
  return {
    calls,
    from(table) {
      const builder = {
        select(columns, options) {
          calls.push({ table, columns, options });
          return builder;
        },
        gte(column, value) {
          calls.push({ gte: { column, value } });
          return Promise.resolve(result);
        },
      };
      return builder;
    },
  };
}

async function runHandler(supabase, { method = 'GET' } = {}) {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => supabase }));
  vi.doMock('../api/_admin-auth.js', () => ({ requireAdminKey: async () => true }));
  const { default: handler } = await import('../api/live-shoppers.js');

  const res = {
    statusCode: 0,
    payload: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
  await handler({ method, query: {} }, res);
  return res;
}

describe('live shopper freshness window', () => {
  it('is at least two storefront heartbeats wide', () => {
    // src/lib/presence.js in ProtoMainSite beats every 60s. A window narrower
    // than two beats drops a live shopper whenever one request is lost.
    const HEARTBEAT_SECONDS = 60;
    expect(FRESHNESS_SECONDS).toBeGreaterThanOrEqual(HEARTBEAT_SECONDS * 2);
  });

  it('is short enough that someone who closed the tab drops off promptly', () => {
    expect(FRESHNESS_SECONDS).toBeLessThanOrEqual(5 * 60);
  });
});

describe('live-shoppers handler', () => {
  it('counts only rows inside the window, without fetching them', async () => {
    const supabase = fakeSupabase({ count: 7, error: null });
    const before = Date.now();

    const res = await runHandler(supabase);
    const after = Date.now();

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ available: true, count: 7 });

    const select = supabase.calls.find((c) => c.options);
    expect(select.options).toMatchObject({ count: 'exact', head: true });

    const gte = supabase.calls.find((c) => c.gte).gte;
    expect(gte.column).toBe('last_seen_at');
    const cutoff = Date.parse(gte.value);
    const windowMs = FRESHNESS_SECONDS * 1000;
    // The cutoff is one window back from the handler's own clock tick.
    expect(cutoff).toBeGreaterThanOrEqual(before - windowMs - 50);
    expect(cutoff).toBeLessThanOrEqual(after - windowMs + 50);
  });

  it('reports zero rather than null when nobody is browsing', async () => {
    const res = await runHandler(fakeSupabase({ count: null, error: null }));
    expect(res.payload).toMatchObject({ available: true, count: 0 });
  });

  it('degrades quietly when the portal has not applied migration 065 yet', async () => {
    const res = await runHandler(fakeSupabase({
      count: null,
      error: { message: 'relation "public.customer_presence" does not exist' },
    }));

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ available: false, count: 0 });
  });

  it('still surfaces a genuine database error', async () => {
    const res = await runHandler(fakeSupabase({ count: null, error: { message: 'permission denied' } }));
    expect(res.statusCode).toBe(400);
    expect(res.payload.error).toBe('permission denied');
  });

  it('rejects anything but GET', async () => {
    const res = await runHandler(fakeSupabase({ count: 0, error: null }), { method: 'POST' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
  });

  it('never lets a dashboard poll be cached', async () => {
    const res = await runHandler(fakeSupabase({ count: 3, error: null }));
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
