import { describe, expect, it } from 'vitest';
import { normalizeUnitsOfIssue, sellingUnitLabel } from '../lib/selling-unit.mjs';

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
