import { describe, expect, it } from 'vitest';
import { buildServerSnapshot } from '../api/codex-analytics-jobs.js';

function source(payload, assertions = () => {}) {
  return async (req, res) => {
    assertions(req);
    return res.status(200).json(payload);
  };
}

describe('server-authoritative Codex analytics jobs', () => {
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
