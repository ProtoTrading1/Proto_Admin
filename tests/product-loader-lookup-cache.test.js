import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveProductByCode, fetchProductLookupMap } = vi.hoisted(() => ({
  resolveProductByCode: vi.fn(),
  fetchProductLookupMap: vi.fn(),
}));

vi.mock('../api/_sql-provider.js', () => ({ resolveProductByCode }));
vi.mock('../api/_sql-stmast.js', () => ({ toSqlPreview: (product) => product }));
vi.mock('../api/_sku-match.js', () => ({
  fetchProductLookupMap,
  findProductBySku: (map, code) => map.get(code),
}));

import { fetchDormantSkuSetForCodes, resolveProductLoaderMatch } from '../api/_product-loader-lookup.js';

describe('Product Loader bounded source lookup', () => {
  beforeEach(() => {
    resolveProductByCode.mockReset().mockResolvedValue({
      dataSource: 'erp_sql', bridgeAttempted: true,
      product: { code: '8620200200', title: 'RHINESTONE STICKER', price: 8.26, units_of_issue: 'CARD', available: 30 },
    });
    fetchProductLookupMap.mockReset().mockResolvedValue(new Map());
  });

  it('reuses one exact Positill and website read across image slots but checks each slot warning', async () => {
    const websiteReads = vi.fn(async () => ({
      data: { sku: '8620200200', price: 9.5, image_url_one: 'old-image.jpg', image_url_two: null },
    }));
    const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: websiteReads }) }) }) };
    const lookupCache = new Map();
    const common = { code: '8620200200', fullCode: '8620200200', strictExact: true, lookupCache, dormantSkus: new Set() };
    const [first, second] = await Promise.all([
      resolveProductLoaderMatch(sb, { ...common, imageSlot: 1 }),
      resolveProductLoaderMatch(sb, { ...common, imageSlot: 2 }),
    ]);
    expect(resolveProductByCode).toHaveBeenCalledOnce();
    expect(websiteReads).toHaveBeenCalledOnce();
    expect(fetchProductLookupMap).toHaveBeenCalledOnce();
    expect(first.warnings).toContain('image_exists');
    expect(second.warnings).not.toContain('image_exists');
    expect([first.unitsOfIssue, second.unitsOfIssue]).toEqual(['CARD', 'CARD']);
  });

  it('queries only requested archived SKUs in bounded groups', async () => {
    const requested = [];
    const sb = {
      from: (table) => {
        expect(table).toBe('archived_products');
        return { select: () => ({ eq: () => ({ in: async (_column, codes) => {
          requested.push(codes);
          return { data: codes.includes('SKU200') ? [{ sku: 'sku200' }] : [], error: null };
        } }) }) };
      },
    };
    const codes = Array.from({ length: 205 }, (_, i) => `sku${i}`);
    const found = await fetchDormantSkuSetForCodes(sb, [...codes, 'sku200']);
    expect(requested.map((group) => group.length)).toEqual([100, 100, 5]);
    expect(found).toEqual(new Set(['SKU200']));
  });
});
