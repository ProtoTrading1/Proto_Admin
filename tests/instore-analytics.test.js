import { describe, expect, it } from 'vitest';
import { isInstorePageView, summarizeInstoreAnalytics } from '../lib/instore-analytics.mjs';

describe('Instore analytics', () => {
  it('counts only the exact Instore routes, including the legacy route', () => {
    expect(isInstorePageView({ event_type: 'category_view', entity_id: 'instore-products' })).toBe(true);
    expect(isInstorePageView({ event_type: 'category_view', entity_id: 'extended-range/beads' })).toBe(true);
    expect(isInstorePageView({ event_type: 'category_view', entity_id: 'instore-products-old' })).toBe(false);
  });

  it('joins product views and order lines by exact SKU without duplicate order counts', () => {
    const result = summarizeInstoreAnalytics({
      products: [{ sku: '8626000775B', title: 'STORAGE BAG' }, { sku: '8620200200', title: 'RHINESTONE STICKER' }],
      events: [
        { event_type: 'category_view', entity_id: 'instore-products' },
        { event_type: 'category_view', entity_id: 'instore-products' },
        { event_type: 'product_view', entity_id: '8626000775B' },
        { event_type: 'product_view', entity_id: '8626000775' },
        { event_type: 'product_view', entity_id: '8620200200' },
      ],
      orders: [
        { final_items: [{ productId: '8626000775B', qty: 2 }, { productId: 'legacy-id', code: '8620200200', qty: 3 }] },
        { items: [{ code: '8626000775', qty: 7 }] },
      ],
    });
    expect(result).toMatchObject({ productViews: 2, ordersWithInstore: 1, unitsOrdered: 5 });
    expect(result).not.toHaveProperty('pageViews');
    expect(result.topProducts).toContainEqual({ sku: '8626000775B', title: 'STORAGE BAG', views: 1, unitsOrdered: 2 });
  });

  it('does not invent an Instore order from invalid quantities', () => {
    expect(summarizeInstoreAnalytics({ products: [{ sku: '123' }], orders: [{ items: [{ code: '123', qty: 0 }] }] }).ordersWithInstore).toBe(0);
  });

  it('excludes cancelled orders and falls back when final_items is empty', () => {
    const result = summarizeInstoreAnalytics({
      products: [{ sku: '123', title: 'Test' }],
      orders: [
        { status: 'cancelled', final_items: [{ code: '123', qty: 9 }] },
        { status: 'payment received', final_items: [], original_items: [{ code: '123', qty: 2 }] },
      ],
    });
    expect(result).toMatchObject({ ordersWithInstore: 1, unitsOrdered: 2 });
  });

  it('fills quiet days and uses South African dates for its trend', () => {
    const result = summarizeInstoreAnalytics({
      products: [{ sku: '123' }],
      events: [{ event_type: 'product_view', entity_id: '123', created_at: '2026-09-25T23:30:00Z' }],
      orders: [{ created_at: '2026-09-26T10:00:00Z', items: [{ code: '123', qty: 3 }] }],
      since: '2026-09-24T22:00:00Z',
      asOf: '2026-09-27T20:00:00Z',
    });
    expect(result.days).toEqual([
      { date: '2026-09-25', productOpens: 0, orders: 0, units: 0 },
      { date: '2026-09-26', productOpens: 1, orders: 1, units: 3 },
      { date: '2026-09-27', productOpens: 0, orders: 0, units: 0 },
    ]);
  });
});
