import { describe, expect, it } from 'vitest';
import { buildPricingPreflight } from '../src/lib/pricingPreflight.js';

const products = [
  { id: 'a', code: 'A', name: 'Alpha', price: 100 },
  { id: 'b', code: 'B', name: 'Beta', price: 50 },
];

describe('pricing preflight', () => {
  it('calculates the exact before and after values before any write', () => {
    const result = buildPricingPreflight(products, ['a', 'b'], -10);
    expect(result).toMatchObject({ blocked: false, oldTotal: 150, newTotal: 135, difference: -15 });
    expect(result.rows.map((row) => row.newPrice)).toEqual([90, 45]);
  });

  it('blocks zero, excessive and invalid-price changes', () => {
    expect(buildPricingPreflight(products, ['a'], 0).blocked).toBe(true);
    expect(buildPricingPreflight(products, ['a'], 51).blocked).toBe(true);
    expect(buildPricingPreflight([{ id: 'x', price: 0 }], ['x'], 10).blocked).toBe(true);
  });

  it('requires typed confirmation for high-impact adjustments', () => {
    const result = buildPricingPreflight(products, ['a', 'b'], -15);
    expect(result.highRisk).toBe(true);
    expect(result.confirmationPhrase).toBe('APPLY -15% TO 2 PRODUCTS');
  });
});
