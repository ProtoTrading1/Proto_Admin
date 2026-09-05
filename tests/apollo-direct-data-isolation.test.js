import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminKey: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('../api/_admin-auth.js', () => ({ requireAdminKey: mocks.requireAdminKey }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import attentionHandler from '../api/customer-attention.js';
import orderLeaderHandler from '../api/apollo-order-leader.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Apollo direct data isolation', () => {
  it.each([
    ['customer attention', attentionHandler],
    ['buyer ranking', orderLeaderHandler],
  ])('blocks %s before auth or Supabase access in an unconfigured preview', async (_label, handler) => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const res = response();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(mocks.requireAdminKey).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
