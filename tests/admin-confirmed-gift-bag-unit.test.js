import { describe, expect, it } from 'vitest';
import { applyAdminConfirmedGiftBagEach, isAdminConfirmedGiftBagEach } from '../lib/admin-confirmed-gift-bag-unit.mjs';
import { receivedInvoiceLinesToSellable } from '../lib/received-stock-unit.mjs';

const categoryPath = ['Packaging & Storage', 'Gifts & Wrapping', 'Gift Bags'];
const boutiqueCategoryPath = [...categoryPath, 'Boutique'];
const pcs = [{ qty: 505, unit: 'PCS' }];

describe('admin-confirmed Gift Bags unit mapping', () => {
  it('applies to an explicit descendant such as Boutique', () => {
    expect(isAdminConfirmedGiftBagEach({
      sku: '8616500371',
      description: 'GIFTBAG BROWN 28*33cm',
      categoryPath: boutiqueCategoryPath,
      receiptLines: [{ qty: 12, unit: 'PCS' }],
    })).toBe(true);
  });
  it('confirms EACH only for the exact selected category, SKU band, description, and PCS-only receipt', () => {
    expect(isAdminConfirmedGiftBagEach({ sku: '8616500371', description: 'GIFT BAG LEAF PRINT', categoryPath, receiptLines: pcs })).toBe(true);
    expect(applyAdminConfirmedGiftBagEach({
      code: '8616500371',
      description: 'GIFT BAG LEAF PRINT',
      warnings: ['selling_unit_required'],
    }, categoryPath, pcs)).toMatchObject({ unitsOfIssue: 'EACH', sellingUnitSource: 'admin_confirmed_gift_bag_each', warnings: [] });
    expect(receivedInvoiceLinesToSellable(pcs, 'EACH')).toMatchObject({ receivedPieces: 505, sellableQty: 505, remainder: 0, unitsOfIssue: 'EACH' });
  });

  it.each([
    ['wrong category', { categoryPath: ['Packaging & Storage', 'Gifts & Wrapping', 'Gift Boxes'] }],
    ['invalid SKU', { sku: 'BAG-1' }],
    ['non-bag description', { description: 'METAL BEADS' }],
    ['pack receipt', { receiptLines: [{ qty: 5, unit: 'PKS' }] }],
    ['mixed receipt', { receiptLines: [{ qty: 5, unit: 'PCS' }, { qty: 1, unit: 'PKS' }] }],
  ])('does not apply for %s', (_label, override) => {
    expect(isAdminConfirmedGiftBagEach({
      sku: '8616500371',
      description: 'GIFT BAG LEAF PRINT',
      categoryPath,
      receiptLines: pcs,
      ...override,
    })).toBe(false);
  });

  it('continues to apply to future ten-digit Gift Bags SKUs outside this shipment range', () => {
    expect(isAdminConfirmedGiftBagEach({
      sku: '8629999999',
      description: 'GIFT BAG BLUE',
      categoryPath,
      receiptLines: [{ qty: 12, unit: 'PCS' }],
    })).toBe(true);
  });

  it('does not replace an existing unit, including a Positill unit', () => {
    const row = { code: '8616500371', description: 'GIFT BAG LEAF PRINT', unitsOfIssue: 'PACK 10' };
    expect(applyAdminConfirmedGiftBagEach(row, categoryPath, pcs)).toBe(row);
  });
});
