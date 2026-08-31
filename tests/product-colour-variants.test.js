import { describe, expect, it } from 'vitest';
import {
  assignColourVariantImageSlots,
  parseColourVariantFilename,
} from '../lib/product-colour-variants.mjs';
import {
  customerPriceFromPositill,
  resolveLoaderCustomerPrice,
} from '../lib/catalogue-price.mjs';

describe('Product Loader colour variants', () => {
  it('splits a recognised suffix from the Positill base code', () => {
    expect(parseColourVariantFilename('8621000002-WHT.jpg')).toMatchObject({
      positillCode: '8621000002',
      variantCode: 'WHT',
      variantLabel: 'White',
      variantSku: '8621000002-WHT',
    });
  });

  it('repairs spaces around the separator and maps Camel', () => {
    expect(parseColourVariantFilename('8621000002- CAM.2.jpg')).toMatchObject({
      positillCode: '8621000002',
      variantCode: 'CAM',
      variantLabel: 'Camel',
      preferredSlot: 2,
    });
  });

  it('does not reinterpret a real dashed Positill code as a colour', () => {
    expect(parseColourVariantFilename('MP198-1.jpg')).toBeNull();
  });

  it('keeps a dashed Positill code and reads only the final colour suffix', () => {
    expect(parseColourVariantFilename('MP198-1-WHT.jpg')).toMatchObject({
      positillCode: 'MP198-1',
      variantCode: 'WHT',
      variantSku: 'MP198-1-WHT',
    });
  });

  it.each([
    ['8630330014-DPNK.jpg', '8630330014', 'DPNK', 'Dark Pink'],
    ['8630330014-DRED.jpg', '8630330014', 'DRED', 'Dark Red'],
    ['8630330014-LPNK.jpg', '8630330014', 'LPNK', 'Light Pink'],
    ['8630330014-LRED.jpg', '8630330014', 'LRED', 'Light Red'],
    ['8630330015-LPUR.jpg', '8630330015', 'LPUR', 'Light Purple'],
  ])('preserves the supplied colour suffix in %s', (filename, positillCode, variantCode, variantLabel) => {
    expect(parseColourVariantFilename(filename)).toMatchObject({
      positillCode,
      variantCode,
      variantLabel,
      variantSku: `${positillCode}-${variantCode}`,
    });
  });

  it('keeps duplicate images on independent slots for one supplied colour SKU', () => {
    const rows = [
      '8630330015-PNK.jpg',
      '8630330015-PNK (2).jpg',
    ].map((filename) => ({
      filename,
      colourVariant: parseColourVariantFilename(filename),
    }));

    const assigned = assignColourVariantImageSlots(rows);
    expect(assigned.map((row) => [row.colourVariant.variantSku, row.assignedImageSlot])).toEqual([
      ['8630330015-PNK', 1],
      ['8630330015-PNK', 2],
    ]);
  });

  it('allocates independent 1-4 galleries for each colour', () => {
    const rows = [
      '8621000002-WHT.jpg',
      '8621000002-CRM.jpg',
      '8621000002-CRM.2.jpg',
      '8621000002-WHT.2.jpg',
      '8621000002-CAM.2.jpg',
      '8621000002-CAM.jpg',
    ].map((filename) => ({
      filename,
      colourVariant: parseColourVariantFilename(filename),
    }));

    const assigned = assignColourVariantImageSlots(rows);
    expect(assigned.map((row) => [row.colourVariant.variantSku, row.assignedImageSlot])).toEqual([
      ['8621000002-WHT', 1],
      ['8621000002-CRM', 1],
      ['8621000002-CRM', 2],
      ['8621000002-WHT', 2],
      ['8621000002-CAM', 2],
      ['8621000002-CAM', 1],
    ]);
  });

  it('blocks the fifth image instead of overwriting an existing slot', () => {
    const rows = [1, 2, 3, 4, 5].map((copyIndex) => ({
      filename: `8621000002-WHT (${copyIndex}).jpg`,
      colourVariant: {
        ...parseColourVariantFilename('8621000002-WHT.jpg'),
        copyIndex,
      },
    }));
    const assigned = assignColourVariantImageSlots(rows);
    expect(assigned.filter((row) => row.tooManyVariantImages)).toHaveLength(1);
  });

  it('converts Positill PRICE_A from ex VAT to the website price grid', () => {
    expect(customerPriceFromPositill(43.04)).toBe(49.5);
    expect(customerPriceFromPositill(25.65)).toBe(29.5);
    expect(customerPriceFromPositill(19.57)).toBe(22.5);
    expect(customerPriceFromPositill(0)).toBe(0);
    expect(customerPriceFromPositill(-5)).toBe(0);
  });

  it('preserves an established website price before converting ERP values', () => {
    expect(resolveLoaderCustomerPrice({
      productSellPrice: 43.04,
      websitePrice: 49.5,
      positillPrice: 43.04,
    })).toEqual({
      price: 49.5,
      source: 'website_stock.price_incl_vat',
    });
  });

  it('converts raw PRICE_A when no established website price exists yet', () => {
    expect(resolveLoaderCustomerPrice({
      positillPrice: 43.04,
    })).toEqual({
      price: 49.5,
      source: 'positill.cached_price_a_ex_vat_converted',
    });
  });

  it('uses live Positill ahead of a stale synchronised price for 8613100205', () => {
    expect(resolveLoaderCustomerPrice({
      productSellPrice: 5.22,
      positillPrice: 8.26,
      positillSource: 'erp_sql',
    })).toEqual({
      price: 9.5,
      source: 'positill.live_price_a_ex_vat_converted',
    });
  });

  it.each([
    '8613100204', '8613100205', '8613100206', '8613100207',
    '8613100208', '8613100209', '8613100210', '8613100211',
  ])('keeps the %s colour range on the R9.50 live price', () => {
    expect(resolveLoaderCustomerPrice({
      productSellPrice: 5.22,
      positillPrice: 8.26,
      positillSource: 'erp_sql',
    }).price).toBe(9.5);
  });

  it('repairs an established loader price carrying the ex-VAT fingerprint', () => {
    expect(resolveLoaderCustomerPrice({
      productSellPrice: 19.57,
      websitePrice: 19.57,
      positillPrice: 19.57,
    })).toEqual({
      price: 22.5,
      source: 'website_stock.price_ex_vat_repaired',
    });
  });
});
