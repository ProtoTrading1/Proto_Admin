import { describe, expect, it } from 'vitest';
import { availabilityFor, cleanSku, parseInstoreFilename } from '../lib/instore-intake.mjs';
describe('Instore intake contracts', () => {
  it('parses only strict image filenames and slots', () => {
    expect(parseInstoreFilename('ABC123.2.jpg')).toMatchObject({ sku: 'ABC123', imageSlot: 2, error: null });
    expect(parseInstoreFilename('ABC 123.jpg').sku).toBe('');
    expect(parseInstoreFilename('ABC123.gif').error).toBe('unsupported_filename');
  });
  it('gates availability modes', () => {
    expect(availabilityFor({ available: 0, mode: 'stock_available' }).error).toBe('no_stock_available');
    expect(availabilityFor({ available: 7, mode: 'stock_available' })).toMatchObject({
      mode: 'stock_available', confirmedQty: 7, error: null,
    });
    expect(availabilityFor({ available: 0, mode: 'to_order' }).error).toBeNull();
    expect(availabilityFor({ available: -1, mode: 'to_order' }).error).toBe('invalid_stock_quantity');
    expect(availabilityFor({ available: 'not-a-number', mode: 'positill' }).error).toBe('stock_unavailable');
  });
  it('normalizes SKU safely', () => expect(cleanSku(' ab-12 ')).toBe('AB-12'));
});
