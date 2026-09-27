import { describe, expect, it } from 'vitest';
import { applyAdminConfirmedBatchEach, isAdminConfirmedBatchEach } from '../lib/admin-confirmed-batch-unit.mjs';

const categoryPath = ['Beauty & Personal Care', 'Fragrance', 'Room Diffusers'];
const pcs = [{ qty: 20, unit: 'PCS' }];

describe('batch-scoped admin EACH confirmation', () => {
  it('applies EACH only after explicit confirmation for a PCS-only selected item', () => {
    const row = { code: '8626030113', description: 'ROOM DIFFUSER', warnings: ['selling_unit_required'] };
    expect(applyAdminConfirmedBatchEach(row, categoryPath, pcs, false)).toBe(row);
    expect(applyAdminConfirmedBatchEach(row, categoryPath, pcs, true)).toMatchObject({
      unitsOfIssue: 'EACH',
      sellingUnitSource: 'admin_confirmed_batch_each',
      warnings: [],
    });
  });

  it.each([
    ['missing destination', { categoryPath: [] }],
    ['invalid SKU', { sku: 'DIFFUSER-1' }],
    ['pack receipt', { receiptLines: [{ qty: 5, unit: 'PKS' }] }],
    ['mixed receipt', { receiptLines: [{ qty: 5, unit: 'PCS' }, { qty: 1, unit: 'PKS' }] }],
    ['zero receipt', { receiptLines: [{ qty: 0, unit: 'PCS' }] }],
  ])('fails closed for %s', (_label, override) => {
    expect(isAdminConfirmedBatchEach({
      sku: '8626030113',
      categoryPath,
      receiptLines: pcs,
      ...override,
    })).toBe(false);
  });

  it('never replaces an existing Positill or description-derived unit', () => {
    const row = { code: '8626030113', unitsOfIssue: 'PACK 6' };
    expect(applyAdminConfirmedBatchEach(row, categoryPath, pcs, true)).toBe(row);
  });
});
