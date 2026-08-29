import { describe, expect, it, vi } from 'vitest';

const { checkRateLimitMock, createClientMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('../api/_rate-limit.js', () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

import handler, { READ_ONLY_PREVIEW_MESSAGE, buildServerSnapshot, isAnalyticsWriteRuntime, isProductionAnalyticsRuntime } from '../api/codex-analytics-jobs.js';

function source(payload, assertions = () => {}) {
  return async (req, res) => {
    assertions(req);
    return res.status(200).json(payload);
  };
}

describe('server-authoritative Codex analytics jobs', () => {
  it('blocks preview writes before authentication or database access', async () => {
    const originalVercelEnv = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    const response = {
      headers: {},
      statusCode: 200,
      payload: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    try {
      await handler({ method: 'POST', headers: {}, body: { periodDays: 30 } }, response);
    } finally {
      if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = originalVercelEnv;
    }

    expect(response.statusCode).toBe(409);
    expect(response.payload).toEqual({ error: READ_ONLY_PREVIEW_MESSAGE });
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('fails closed outside an explicit production runtime', () => {
    expect(isProductionAnalyticsRuntime({ VERCEL_ENV: 'production' })).toBe(true);
    expect(isProductionAnalyticsRuntime({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(isProductionAnalyticsRuntime({ VERCEL_ENV: 'development' })).toBe(false);
    expect(isProductionAnalyticsRuntime({})).toBe(false);
    expect(isAnalyticsWriteRuntime({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(isAnalyticsWriteRuntime({
      VERCEL_ENV: 'preview',
      ANALYTICS_PREVIEW_WRITES_ENABLED: 'true',
      ANALYTICS_PREVIEW_PROJECT_REF: 'xicygaamdogfdpzyrlcp',
      ANALYTICS_PREVIEW_GATEWAY_URL: 'https://xicygaamdogfdpzyrlcp.supabase.co/functions/v1/proto-analytics-preview-gateway',
      ANALYTICS_PREVIEW_GATEWAY_SECRET: 'temporary-test-secret',
    })).toBe(true);
    expect(isAnalyticsWriteRuntime({
      VERCEL_ENV: 'preview',
      ANALYTICS_PREVIEW_WRITES_ENABLED: 'true',
      ANALYTICS_PREVIEW_PROJECT_REF: 'kyodrsqnmihwoplkhwwf',
      ANALYTICS_PREVIEW_GATEWAY_URL: 'https://kyodrsqnmihwoplkhwwf.supabase.co/functions/v1/proto-analytics-preview-gateway',
      ANALYTICS_PREVIEW_GATEWAY_SECRET: 'temporary-test-secret',
    })).toBe(false);
  });

  it('builds the model snapshot from authenticated server reads', async () => {
    const req = { headers: { authorization: 'Bearer verified-admin' } };
    const snapshot = await buildServerSnapshot(req, 30, {
      attention: source({ available: true, totalActiveSeconds: 60, products: [{ id: 'SKU-1' }], categories: [] }, (inner) => {
        expect(inner.method).toBe('GET');
        expect(inner.query.range).toBe('month');
        expect(inner.headers).toBe(req.headers);
      }),
      orders: source({ summary: { totalOrders: 2 }, topOrderedProducts: [], topOrderedCategories: [] }),
      search: source({ kpis: { totalSearches: 3 }, zeroResultTerms: [] }),
      baskets: source({ summary: { basketCount: 4 } }),
    });
    expect(snapshot.periodDays).toBe(30);
    expect(snapshot.attention.totalActiveSeconds).toBe(60);
    expect(snapshot.orders.summary.totalOrders).toBe(2);
    expect(snapshot.search.kpis.totalSearches).toBe(3);
    expect(snapshot.baskets.basketCount).toBe(4);
  });

  it('fails closed when any authenticated source fails', async () => {
    await expect(buildServerSnapshot({ headers: {} }, 7, {
      attention: source({ error: 'source unavailable' }, () => {}),
      orders: source({}, () => {}),
      search: source({}, () => {}),
      baskets: async (req, res) => res.status(503).json({ error: 'source unavailable' }),
    })).rejects.toThrow('source unavailable');
  });
});
