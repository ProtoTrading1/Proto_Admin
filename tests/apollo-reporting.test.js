import { describe, expect, it } from 'vitest';
import { aggregateWebsiteOrders, evidenceEnvelope, normalizePositillRows, paginateSelect, reconcileByReference, reportingWindow } from '../lib/apollo-reporting.mjs';

describe('Apollo reporting foundation', () => {
  it('builds deterministic SAST windows', () => {
    expect(reportingWindow('custom', { start: '2026-09-01', end: '2026-09-01' })).toMatchObject({ start: '2026-08-31T22:00:00.000Z', end: '2026-09-01T22:00:00.000Z' });
    expect(reportingWindow('month', { now: '2026-09-12T12:00:00Z' })).toMatchObject({ start: '2026-08-31T22:00:00.000Z', end: '2026-09-30T22:00:00.000Z' });
  });
  it('keeps unknown evidence distinct from zero', () => {
    expect(evidenceEnvelope({ value: null, source: 'POSWINSQL' })).toMatchObject({ value: null, known: false });
    expect(evidenceEnvelope({ value: 0, source: 'POSWINSQL' }).known).toBe(true);
  });
  it('paginates and fails closed at the cap', async () => {
    expect(await paginateSelect({ pageSize: 2, maxRows: 4, selectPage: async ({ from }) => ({ data: from ? [{ id: 2 }] : [{ id: 1 }, { id: 1 }] }) })).toHaveLength(3);
    await expect(paginateSelect({ pageSize: 2, maxRows: 4, selectPage: async () => ({ data: [{ id: 1 }, { id: 1 }] }) })).rejects.toMatchObject({ code: 'PAGINATION_CAP_EXCEEDED' });
  });
  it('aggregates VAT-inclusive website totals and explicit variant keys', () => {
    expect(aggregateWebsiteOrders([{ status: 'paid', total_ex_vat: 115, final_items: [{ variant_sku: 'V1', parent_sku: 'P1', qty: 2 }] }])).toMatchObject({ orders: 1, revenue: 115, statuses: { 'payment received': 1 }, products: [{ key: 'V1', parentKey: 'P1', units: 2 }] });
    expect(aggregateWebsiteOrders([{ status: 'cancelled', total_ex_vat: 115 }]).statuses).toEqual({ cancelled: 1 });
  });
  it('rejects unknown POS semantics and reconciles by reference only', () => {
    expect(() => normalizePositillRows([{ type: 'invoice', amount: 10 }], { taxBasis: 'unknown' })).toThrow(/tax basis/i);
    expect(normalizePositillRows([{ type: 'credit_note', amount: -10, quantity: -1 }], { taxBasis: 'incl_vat', typeSigns: { credit_note: -1 }, amountSignConvention: 'as_stored' })[0].amount).toBe(-10);
    expect(reconcileByReference([{ reference: 'A', amount: 1 }], [{ reference: 'A', amount: 999 }])[0].matched).toBe(true);
  });
  it('uses Monday-start SAST weeks including Sunday and the UTC rollover', () => {
    expect(reportingWindow('week', { now: '2026-09-13T12:00:00Z' }).start).toBe('2026-09-06T22:00:00.000Z');
    expect(reportingWindow('week', { now: '2026-09-13T22:30:00Z' }).start).toBe('2026-09-13T22:00:00.000Z');
    expect(() => reportingWindow('custom', { start: '2026-02-30', end: '2026-03-02' })).toThrow();
  });
  it('never turns null or blank monetary evidence into zero', () => {
    for (const total_ex_vat of [null, undefined, '', 'bad', Infinity]) {
      expect(aggregateWebsiteOrders([{ total_ex_vat }]).revenue).toBeNull();
    }
    expect(aggregateWebsiteOrders([]).revenue).toBe(0);
  });
  it('honours final empty items and handles nested legacy product shapes', () => {
    const summary = aggregateWebsiteOrders([{ total_ex_vat: 25, items: [{ product: { sku: 'BLUE', price: 12.5 }, qty: 2 }] }]);
    expect(summary.products[0]).toMatchObject({ key: 'BLUE', units: 2, value: 25 });
    expect(aggregateWebsiteOrders([{ total_ex_vat: 0, final_items: [], items: [{ code: 'OLD', qty: 2 }] }]).products).toEqual([]);
    expect(aggregateWebsiteOrders([{ total_ex_vat: 10, items: [{ code: 'X', qty: null }] }]).productsComplete).toBe(false);
  });
  it('prefers customer-facing codes over internal product ids', () => {
    const summary = aggregateWebsiteOrders([{ total_ex_vat: 50, items: [
      { productId: 'internal-flat', code: 'FLAT-SKU', qty: 1, unitPrice: 10 },
      { product: { id: 'internal-nested', code: 'NESTED-SKU', price: 20 }, qty: 2 },
    ] }]);
    expect(summary.products.map(row => row.key).sort()).toEqual(['FLAT-SKU', 'NESTED-SKU']);
  });
  it('marks missing or malformed product item contracts incomplete', () => {
    expect(aggregateWebsiteOrders([{ total_ex_vat: 10 }])).toMatchObject({ productsComplete: false, complete: false });
    expect(aggregateWebsiteOrders([{ total_ex_vat: 10, items: [null] }])).toMatchObject({ productsComplete: false, complete: false });
    expect(aggregateWebsiteOrders([{ total_ex_vat: 0, final_items: [] }])).toMatchObject({ productsComplete: true, complete: true });
  });
  it('excludes cancelled orders from order value and rankings while preserving their count', () => {
    const summary = aggregateWebsiteOrders([{ status: 'cancelled', total_ex_vat: 300, items: [{ code: 'X', qty: 3 }] }]);
    expect(summary).toMatchObject({ orders: 1, cancelledOrders: 1, revenue: 0, products: [] });
  });
  it('fails closed on missing pages, oversized pages and a full shortened final page', async () => {
    await expect(paginateSelect({ selectPage: async () => ({ data: null }) })).rejects.toMatchObject({ code: 'INVALID_PAGE' });
    await expect(paginateSelect({ pageSize: 2, maxRows: 3, selectPage: async () => [1, 2, 3] })).rejects.toMatchObject({ code: 'INVALID_PAGE' });
    await expect(paginateSelect({ pageSize: 2, maxRows: 3, selectPage: async ({ from }) => from ? [3] : [1, 2] })).rejects.toMatchObject({ code: 'PAGINATION_CAP_EXCEEDED' });
  });
  it('rejects ambiguous references and never joins by matching amounts', () => {
    expect(() => reconcileByReference([{ reference: 'A' }, { reference: 'A' }], [{ reference: 'A' }])).toThrow();
    expect(() => reconcileByReference([{ reference: 'A' }], [{ reference: 'A' }, { reference: 'A' }])).toThrow();
    expect(reconcileByReference([{ reference: 'A', amount: 10 }], [{ reference: 'B', amount: 10 }])[0].matched).toBe(false);
  });
  it('requires verified POS sign conventions and prevents double-negating credits', () => {
    const config = { taxBasis: 'incl_vat', typeSigns: { credit: -1 }, amountSignConvention: 'signed_by_mapping' };
    expect(normalizePositillRows([{ type: 'credit', amount: 10, quantity: 2 }], config)[0]).toMatchObject({ amount: -10, quantity: -2 });
    expect(() => normalizePositillRows([{ type: 'credit', amount: -10, quantity: -2 }], config)).toThrow();
    expect(() => normalizePositillRows([{ type: 'credit', amount: null, quantity: 2 }], config)).toThrow();
    expect(() => normalizePositillRows([], { taxBasis: 'incl_vat' })).toThrow();
  });
});
