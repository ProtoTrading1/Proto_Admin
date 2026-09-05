import { describe, expect, it } from 'vitest';
import { orderLineQuantity, orderUnits, publicBuyerRanking, rankCustomersByUnits, rollingWindow, weekToDateWindow } from '../lib/customer-purchase-ranking.mjs';

const order = (overrides = {}) => ({
  customer_id: 'customer-a',
  total_ex_vat: 100,
  customers: { name: 'Jane Smith', business_name: 'Alpha Traders' },
  final_items: [{ qty: 2 }, { quantity: 3 }],
  ...overrides,
});

describe('privacy-safe customer purchase ranking', () => {
  it('counts valid quantities from the final order items', () => {
    expect(orderLineQuantity({ qty: '2' })).toBe(2);
    expect(orderLineQuantity({ quantity: 3 })).toBe(3);
    expect(orderLineQuantity({ qty: -1 })).toBe(0);
    expect(orderLineQuantity({ qty: 'invalid' })).toBe(0);
    expect(orderUnits(order())).toBe(5);
  });

  it('ranks by units with deterministic spend, order-count and name tie breakers', () => {
    const result = rankCustomersByUnits([
      order(),
      order({ customer_id: 'customer-b', total_ex_vat: 150, customers: { business_name: 'Beta Stores' }, final_items: [{ qty: 5 }] }),
      order({ customer_id: 'customer-c', total_ex_vat: 90, customers: { business_name: 'Gamma Shop' }, final_items: [{ qty: 8 }] }),
    ]);
    expect(result.map((row) => row.companyName)).toEqual(['Gamma Shop', 'Beta Stores', 'Alpha Traders']);
  });

  it('aggregates multiple orders and never returns email or contact fields', () => {
    const result = rankCustomersByUnits([
      order({ customers: { business_name: 'Alpha Traders', email: 'private@example.com', phone: 'secret' } }),
      order({ final_items: [{ qty: 4 }] }),
      order({ customer_id: '', final_items: [{ qty: 999 }] }),
    ], { limit: 1 });
    expect(result).toEqual([{
      customerId: 'customer-a', companyName: 'Alpha Traders', orders: 2, units: 9, spendExVat: 200,
    }]);
    expect(JSON.stringify(result)).not.toMatch(/private@example|phone|secret/);
  });

  it('ignores orders without positive item quantities', () => {
    expect(rankCustomersByUnits([
      order({ final_items: [{ qty: 0 }, { qty: -2 }, { qty: 'bad' }] }),
    ])).toEqual([]);
  });

  it('excludes cancelled or voided orders from the ranking', () => {
    expect(rankCustomersByUnits([
      order({ status: 'cancelled', final_items: [{ qty: 999 }] }),
      order({ customer_id: 'customer-b', status: 'payment received', customers: { business_name: 'Valid Store' }, final_items: [{ qty: 2 }] }),
    ]).map((row) => row.companyName)).toEqual(['Valid Store']);
  });

  it('uses Monday 00:00 South Africa time for this-week questions', () => {
    const window = weekToDateWindow(new Date('2026-09-02T10:00:00.000Z'));
    expect(window).toMatchObject({ from: '2026-08-30T22:00:00.000Z', to: '2026-09-02T10:00:00.000Z', timezone: 'Africa/Johannesburg', label: 'This week' });
  });

  it('returns a restricted public response without IDs, emails or raw items', () => {
    const window = rollingWindow(7, new Date('2026-09-01T10:00:00.000Z'));
    const response = publicBuyerRanking([
      order({ customer_id: 'secret-id', customers: { business_name: 'Alpha Traders', email: 'private@example.com' } }),
    ], window);
    expect(response.leaders[0]).toEqual({ displayName: 'Alpha Traders', units: 5, orders: 1, valueExVat: 100 });
    expect(JSON.stringify(response)).not.toMatch(/secret-id|private@example|customerId|final_items/);
  });
});
