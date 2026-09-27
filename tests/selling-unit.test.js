import { describe, expect, it } from 'vitest';
import { normalizeUnitsOfIssue, sellingUnitLabel } from '../lib/selling-unit.mjs';
import { receivedInvoiceLinesToSellable } from '../lib/received-stock-unit.mjs';

describe('selling units', () => {
  it('normalises common Positill and admin values', () => {
    expect(normalizeUnitsOfIssue('ea')).toBe('EACH');
    expect(normalizeUnitsOfIssue('pack10')).toBe('PACK 10');
    expect(normalizeUnitsOfIssue('pkt x 20')).toBe('PACK 20');
    expect(normalizeUnitsOfIssue('box of 12')).toBe('BOX 12');
    expect(normalizeUnitsOfIssue('card,10')).toBe('CARD 10');
    expect(normalizeUnitsOfIssue('metres')).toBe('METRE');
  });

  it('uses an each fallback and keeps uncommon units usable', () => {
    expect(normalizeUnitsOfIssue('')).toBe('EACH');
    expect(normalizeUnitsOfIssue('tray')).toBe('TRAY');
  });

  it('creates clear customer-facing labels', () => {
    expect(sellingUnitLabel('PACK 10')).toBe('Pack of 10');
    expect(sellingUnitLabel('CARD,10')).toBe('Card of 10');
    expect(sellingUnitLabel('EACH')).toBe('Each');
  });
});

describe('supplier invoice quantities', () => {
  it('keeps PKS quantities as sellable packs and converts only PCS', () => {
    expect(receivedInvoiceLinesToSellable([{ qty: 20, unit: 'PKS' }], 'PACK 10')).toMatchObject({
      sellableQty: 20, receivedPacks: 20, receivedPieces: 0, remainder: 0,
    });
    expect(receivedInvoiceLinesToSellable([{ qty: 19, unit: 'PCS' }], 'PACK 5')).toMatchObject({
      sellableQty: 3, receivedPacks: 0, receivedPieces: 19, remainder: 4,
    });
    expect(receivedInvoiceLinesToSellable([{ qty: 5, unit: 'PKS' }, { qty: 500, unit: 'PCS' }], 'PACK 100')).toMatchObject({
      sellableQty: 10, receivedPacks: 5, receivedPieces: 500, remainder: 0,
    });
  });
});
