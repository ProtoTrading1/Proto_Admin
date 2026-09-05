import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDescriptionRows } from '../src/lib/bulkDescriptionReplace.js';

describe('bulk title replacement spreadsheet', () => {
  it('keeps separate descriptions for SKUs that share a barcode', () => {
    const rows = parseDescriptionRows([
      ['SKU', 'IMAGE NAME', 'BARCODE', 'DESCRIPTION'],
      ['MUG514-BLK', 'MUG514-BLK,MUG514-BLK1', '8626000514', 'BLACK MUG'],
      ['MUG514-WHT', 'MUG514-WHT,MUG514-WHT1', '8626000514', 'WHITE MUG'],
      ['MUG514-BLU', 'MUG514-BLU,MUG514-BLU1', '8626000514', 'BLUE MUG'],
    ]);

    expect(rows).toEqual([
      { sku: 'MUG514-BLK', title: 'BLACK MUG' },
      { sku: 'MUG514-WHT', title: 'WHITE MUG' },
      { sku: 'MUG514-BLU', title: 'BLUE MUG' },
    ]);
  });

  it('normalizes SKU case and lets only a repeated exact SKU correct itself', () => {
    const rows = parseDescriptionRows([
      ['Website SKU', 'Title'],
      [' mug514-blk ', 'Old black title'],
      ['MUG514-WHT', 'White title'],
      ['MUG514-BLK', 'Corrected black title'],
    ]);

    expect(rows).toEqual([
      { sku: 'MUG514-BLK', title: 'Corrected black title' },
      { sku: 'MUG514-WHT', title: 'White title' },
    ]);
  });

  it('rejects a barcode-only sheet instead of risking a multi-SKU overwrite', () => {
    expect(() => parseDescriptionRows([
      ['BARCODE', 'DESCRIPTION'],
      ['8626000514', 'Unsafe shared title'],
    ])).toThrow(/SKU and TITLE columns/);
  });

  it('updates website_stock by SKU and never by barcode', () => {
    const api = readFileSync(new URL('../api/bulk-description-replace.js', import.meta.url), 'utf8');

    expect(api).toContain(".in('sku', chunk)");
    expect(api).toContain(".eq('sku', sku)");
    expect(api).not.toContain(".eq('barcode'");
  });
});
