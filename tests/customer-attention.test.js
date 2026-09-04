import { describe, expect, it } from 'vitest';
import { summariseCustomerAttention } from '../lib/customer-attention.mjs';

describe('customer attention analytics', () => {
  it('aggregates products, categories and customer detail', () => {
    const rows = [
      { customer_id: 'a', content_type: 'product', entity_id: 'SKU1', entity_label: 'Product one', active_seconds: 30, last_seen_at: '2026-08-28T10:00:00Z' },
      { customer_id: 'a', content_type: 'product', entity_id: 'SKU1', entity_label: 'Product one', active_seconds: 60, last_seen_at: '2026-08-28T11:00:00Z' },
      { customer_id: 'b', content_type: 'category', entity_id: 'beads', entity_label: 'Beads', active_seconds: 45, last_seen_at: '2026-08-28T12:00:00Z' },
    ];
    const result = summariseCustomerAttention(rows, [{ id: 'a', name: 'Customer A', business_name: 'Company A' }]);
    expect(result.totalActiveSeconds).toBe(135);
    expect(result.products[0]).toMatchObject({ id: 'SKU1', views: 2, customers: 1, activeSeconds: 90, averageSeconds: 45 });
    expect(result.categories[0]).toMatchObject({ id: 'beads', activeSeconds: 45 });
    expect(result.customerRows[0]).toMatchObject({ customerName: 'Customer A', companyName: 'Company A', views: 2, activeSeconds: 90 });
  });

  it('ignores invalid content types and caps corrupt durations', () => {
    const result = summariseCustomerAttention([
      { customer_id: 'a', content_type: 'search', entity_id: 'private text', active_seconds: 10 },
      { customer_id: 'a', content_type: 'product', entity_id: 'SKU1', active_seconds: 999999 },
    ]);
    expect(result.products[0].activeSeconds).toBe(86400);
    expect(result.totalViews).toBe(1);
    expect(result.totalActiveSeconds).toBe(86400);
  });
});
