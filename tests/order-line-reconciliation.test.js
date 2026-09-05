import { describe, expect, it } from 'vitest';
import { buildEmailItemsFromOrder, orderLineKey } from '../src/lib/orderDocuments.js';

const line = (over = {}) => ({
  productId: 'SKU1',
  code: 'BAR1',
  name: 'Item',
  qty: 2,
  unitPrice: 10,
  ...over,
});

describe('orderLineKey', () => {
  it('prefers productId, falls back to code, trims both', () => {
    expect(orderLineKey({ productId: ' A ', code: 'B' })).toBe('A');
    expect(orderLineKey({ productId: '', code: ' B ' })).toBe('B');
    expect(orderLineKey({})).toBe('');
  });
});

describe('buildEmailItemsFromOrder', () => {
  it('matches unchanged lines one-to-one', () => {
    const rows = buildEmailItemsFromOrder({
      original_items: [line()],
      final_items: [line({ qty: 5 })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].finalQty).toBe(5);
    expect(rows[0].originalQty).toBe(2);
    expect(rows[0].removed).toBe(false);
  });

  it('marks a missing final line as removed', () => {
    const rows = buildEmailItemsFromOrder({
      original_items: [line(), line({ productId: 'SKU2', code: 'BAR2' })],
      final_items: [line()],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].removed).toBe(true);
    expect(rows[1].finalQty).toBe(0);
  });

  it('renders BOTH final lines when two share the same key (was: one silently dropped)', () => {
    const rows = buildEmailItemsFromOrder({
      original_items: [line({ qty: 1 })],
      final_items: [line({ qty: 1 }), line({ qty: 3, name: 'Item second' })],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.finalQty).sort()).toEqual([1, 3]);
    expect(rows.filter((r) => r.removed)).toHaveLength(0);
  });

  it('pairs duplicate-key originals one-to-one instead of duplicating the same final row', () => {
    const rows = buildEmailItemsFromOrder({
      original_items: [line({ qty: 1 }), line({ qty: 7 })],
      final_items: [line({ qty: 1 })],
    });
    expect(rows).toHaveLength(2);
    // First original pairs with the single final line; second is removed —
    // previously both showed finalQty 1 and the removal was invisible.
    expect(rows[0].removed).toBe(false);
    expect(rows[0].finalQty).toBe(1);
    expect(rows[1].removed).toBe(true);
    expect(rows[1].finalQty).toBe(0);
  });

  it('appends swapped-in lines whose key never appeared in the originals', () => {
    const rows = buildEmailItemsFromOrder({
      original_items: [line()],
      final_items: [line(), line({ productId: 'SKU9', code: 'BAR9', qty: 4 })],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].swapped).toBe(true);
    expect(rows[1].finalQty).toBe(4);
  });

  it('falls back to items when original_items is absent and to originals when final_items is absent', () => {
    const rows = buildEmailItemsFromOrder({ items: [line()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].removed).toBe(false);
    expect(rows[0].finalQty).toBe(2);
  });
});
