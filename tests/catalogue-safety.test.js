import { describe, expect, it } from 'vitest';
import {
  canonicalPublishValues,
  evaluateCatalogueValues,
  isDoubleVatSignature,
} from '../lib/catalogue-safety.mjs';

describe('catalogue safety checks', () => {
  it('recognises a second VAT addition', () => {
    expect(isDoubleVatSignature(9.20, 8.00)).toBe(true);
    expect(evaluateCatalogueValues({
      websitePrice: 9.20,
      canonicalPrice: 8.00,
      websiteAvailable: 10,
      canonicalAvailable: 10,
    })[0].code).toBe('double_vat_signature');
  });

  it('does not mistake a correct VAT-inclusive price for double VAT', () => {
    expect(isDoubleVatSignature(49.50, 49.50)).toBe(false);
  });

  it('classifies small and major stock differences separately', () => {
    expect(evaluateCatalogueValues({
      websitePrice: 10,
      canonicalPrice: 10,
      websiteAvailable: 98,
      canonicalAvailable: 100,
    })[0].code).toBe('stock_mismatch');
    expect(evaluateCatalogueValues({
      websitePrice: 10,
      canonicalPrice: 10,
      websiteAvailable: 50,
      canonicalAvailable: 100,
    })[0].code).toBe('major_stock_mismatch');
  });

  it('uses the server-side synchronised product values during publication', () => {
    expect(canonicalPublishValues({
      product: { sell_price: 8, stock_qty: 100, available_stock: 90 },
      submitted: { price: 9.2, stockQty: 80, availableStock: 70 },
    })).toMatchObject({
      blocked: false,
      price: 8,
      stockQty: 100,
      availableStock: 90,
      corrections: ['double_vat_signature', 'major_stock_mismatch'],
    });
  });

  it('blocks a matched ERP product with a zero customer price', () => {
    expect(canonicalPublishValues({
      product: { sell_price: 0, stock_qty: 5 },
      submitted: { price: 10 },
    })).toMatchObject({ blocked: true, code: 'canonical_price_invalid' });
  });

  it('converts a loader ERP price once while preserving a valid website price', () => {
    expect(canonicalPublishValues({
      product: { sell_price: 25.65, stock_qty: 10, available_stock: 8 },
      submitted: { price: 25.65 },
      priceBasis: 'erp_ex_vat',
    })).toMatchObject({ price: 29.5, priceSource: 'products.sell_price_ex_vat_converted' });

    expect(canonicalPublishValues({
      product: { sell_price: 25.65, stock_qty: 10, available_stock: 8 },
      existing: { price: 29.5 },
      submitted: { price: 25.65 },
      priceBasis: 'erp_ex_vat',
    })).toMatchObject({ price: 29.5, priceSource: 'website_stock.price_incl_vat' });
  });

  it('rechecks live Positill during publication instead of using stale synchronised price', () => {
    expect(canonicalPublishValues({
      product: { sell_price: 5.22, stock_qty: 2, available_stock: 2 },
      livePositill: { price: 8.26, onhand: 9, available: 7 },
      positillSource: 'erp_sql',
      submitted: { price: 6, stockQty: 2, availableStock: 2 },
      priceBasis: 'erp_ex_vat',
    })).toMatchObject({
      price: 9.5,
      priceSource: 'positill.live_price_a_ex_vat_converted',
      stockQty: 9,
      availableStock: 7,
    });
  });
});
