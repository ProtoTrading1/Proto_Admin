import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminKey: vi.fn(),
  createClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('../api/_admin-auth.js', () => ({ requireAdminKey: mocks.requireAdminKey }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import handler from '../api/apollo-order-leader.js';

function response() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VERCEL_ENV', 'production');
  mocks.requireAdminKey.mockResolvedValue(true);
  mocks.createClient.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ gte: mocks.gte });
  mocks.gte.mockReturnValue({ lte: mocks.lte });
  mocks.lte.mockResolvedValue({
    data: [{
      customer_id: 'private-id', status: 'pending', total_ex_vat: 250,
      final_items: [{ qty: 8, code: 'PRIVATE-SKU' }],
      customers: { business_name: 'Alpha Traders', name: 'Private Contact', email: 'private@example.com' },
    }],
    error: null,
  });
});

describe('Apollo order leader API', () => {
  it('requires an authenticated admin before reading any order data', async () => {
    mocks.requireAdminKey.mockResolvedValue(false);
    const res = response();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('refuses preview reads before authentication when isolated data is not configured', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const res = response();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(mocks.requireAdminKey).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('returns only the restricted deterministic ranking contract', async () => {
    const res = response();
    await handler({ method: 'GET', query: { window: 'week_to_date' }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body.leaders).toEqual([{ displayName: 'Alpha Traders', units: 8, orders: 1, valueExVat: 250 }]);
    expect(JSON.stringify(res.body)).not.toMatch(/private-id|Private Contact|private@example|PRIVATE-SKU|final_items|customer_id/);
  });

  it('refuses non-GET methods before querying the database', async () => {
    const res = response();
    await handler({ method: 'POST', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('returns a bounded error without leaking database details', async () => {
    mocks.lte.mockResolvedValue({ data: null, error: { message: 'secret schema failure' } });
    const res = response();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Apollo could not read the authenticated online-order ranking.');
    expect(JSON.stringify(res.body)).not.toContain('secret schema failure');
  });
});
