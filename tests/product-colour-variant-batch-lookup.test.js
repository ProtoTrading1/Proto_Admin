import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  lookupWebsiteStockExact,
  resolveProductLoaderMatch,
  fetchDormantSkuSetForCodes,
} = vi.hoisted(() => ({
  lookupWebsiteStockExact: vi.fn(),
  resolveProductLoaderMatch: vi.fn(),
  fetchDormantSkuSetForCodes: vi.fn(async () => new Set()),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }) }),
}));

vi.mock('../api/_admin-auth.js', () => ({
  requireOwner: vi.fn(async () => true),
}));

vi.mock('../api/_sql-provider.js', () => ({
  isSqlConfigured: vi.fn(() => true),
}));

vi.mock('../api/_product-loader-lookup.js', async () => {
  const { parseLoaderFilename } = await vi.importActual('../api/_product-loader-filename.js');
  return {
    classifyBatchItem: (item) => (item.canPublish ? 'ready' : 'not_found'),
    fetchDormantSkuSetForCodes,
    lookupWebsiteStockExact,
    parseLoaderFilename,
    resolveProductLoaderMatch,
  };
});

import handler from '../api/product-loader-batch-lookup.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader: vi.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

describe('Product Loader colour variant batch lookup', () => {
  beforeEach(() => {
    fetchDormantSkuSetForCodes.mockReset().mockResolvedValue(new Set());
    lookupWebsiteStockExact.mockReset().mockResolvedValue(null);
    resolveProductLoaderMatch.mockReset().mockImplementation(async (_sb, request) => ({
      code: request.code,
      displayCode: request.displayCode,
      title: 'LIP GLOSS GLITTER IMAN OF NOBLE',
      price: 7.5,
      priceSource: 'positill.live_price_a_ex_vat_converted',
      erpPriceExVat: 6.52,
      stockOnHand: 1329,
      imageSlot: request.imageSlot,
      sqlRow: {
        code: request.code,
        title: 'LIP GLOSS GLITTER IMAN OF NOBLE',
        price: 6.52,
        onhand: 1329,
        available: 1329,
        dept: '35',
      },
      websiteRow: null,
      warnings: [],
      matchedBy: 'positill_code',
      positillSource: 'erp_sql',
      canPublish: true,
      websiteStatus: 'new',
      needsReview: false,
    }));
  });

  it('checks archive status only for selected parent and full SKUs', async () => {
    const res = responseRecorder();
    await handler({ method: 'POST', body: { filenames: ['8630330015-PNK.jpg', '8630330015-PNK (2).jpg'] } }, res);
    expect(fetchDormantSkuSetForCodes).toHaveBeenCalledOnce();
    expect(fetchDormantSkuSetForCodes.mock.calls[0][1]).toEqual([
      '8630330015', '8630330015-PNK',
      '8630330015', '8630330015-PNK',
    ]);
    expect(res.statusCode).toBe(200);
  });

  it('blocks the whole lookup if archive verification fails', async () => {
    fetchDormantSkuSetForCodes.mockRejectedValueOnce(new Error('archive unavailable'));
    const res = responseRecorder();
    await handler({ method: 'POST', body: { filenames: ['8630330015-PNK.jpg'] } }, res);
    expect(res.statusCode).toBe(503);
    expect(resolveProductLoaderMatch).not.toHaveBeenCalled();
  });

  it('limits simultaneous SKU lookups and preserves file order in a folder', async () => {
    let active = 0;
    let peak = 0;
    resolveProductLoaderMatch.mockImplementation(async (_sb, request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { code: request.code, canPublish: true, warnings: [], imageSlot: 1 };
    });
    const filenames = Array.from({ length: 12 }, (_, index) => `8620200${String(index).padStart(3, '0')}.jpg`);
    const res = responseRecorder();
    await handler({ method: 'POST', body: { filenames, groupColourVariants: false } }, res);
    expect(res.statusCode).toBe(200);
    expect(peak).toBe(4);
    expect(res.body.items.map((item) => item.filename)).toEqual(filenames);
  });

  it('uses one ten-digit Positill SKU for landed image suffixes and never creates copy SKUs', async () => {
    const res = responseRecorder();
    await handler({ method: 'POST', body: {
      filenames: ['8626000775-1.jpg', '8626000775 (2).jpg', '8626000775.2.jpg'],
      groupColourVariants: false,
      strictExact: true,
    } }, res);
    expect(res.statusCode).toBe(200);
    expect(resolveProductLoaderMatch.mock.calls.map(([, request]) => [request.code, request.fullCode, request.imageSlot])).toEqual([
      ['8626000775', '8626000775', 1],
      ['8626000775', '8626000775', 1],
      ['8626000775', '8626000775', 2],
    ]);
    expect(res.body.items.map(({ code }) => code)).toEqual(['8626000775', '8626000775', '8626000775']);
    expect(fetchDormantSkuSetForCodes.mock.calls[0][1]).toEqual(['8626000775', '8626000775', '8626000775']);
  });

  it('keeps a copied colour image on the same website SKU and assigns slot 2', async () => {
    const req = {
      method: 'POST',
      body: {
        filenames: ['8630330015-PNK.jpg', '8630330015-PNK (2).jpg'],
        groupColourVariants: true,
      },
    };
    const res = responseRecorder();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toMatchObject({
      total: 2,
      matched: 2,
      colourVariants: 1,
      colourParents: 1,
    });
    expect(res.body.items.map((item) => ({
      filename: item.filename,
      code: item.code,
      imageSlot: item.imageSlot,
      isColourVariant: item.isColourVariant,
    }))).toEqual([
      {
        filename: '8630330015-PNK.jpg',
        code: '8630330015-PNK',
        imageSlot: 1,
        isColourVariant: true,
      },
      {
        filename: '8630330015-PNK (2).jpg',
        code: '8630330015-PNK',
        imageSlot: 2,
        isColourVariant: true,
      },
    ]);
  });

  it('maps the complete COSMETICS folder into two parents and nine colour variants', async () => {
    const req = {
      method: 'POST',
      body: {
        filenames: [
          '8630330014-DPNK.jpg',
          '8630330014-DRED.jpg',
          '8630330014-LPNK.jpg',
          '8630330014-LRED.jpg',
          '8630330014-RED.jpg',
          '8630330015-LPUR.jpg',
          '8630330015-ORG.jpg',
          '8630330015-PNK (2).jpg',
          '8630330015-PNK.jpg',
          '8630330015-PUR.jpg',
        ],
        groupColourVariants: true,
      },
    };
    const res = responseRecorder();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toMatchObject({
      total: 10,
      matched: 10,
      ready: 10,
      needsReview: 0,
      notFound: 0,
      colourVariants: 9,
      colourParents: 2,
    });
    expect(res.body.items.map((item) => [item.filename, item.code, item.imageSlot])).toEqual([
      ['8630330014-DPNK.jpg', '8630330014-DPNK', 1],
      ['8630330014-DRED.jpg', '8630330014-DRED', 1],
      ['8630330014-LPNK.jpg', '8630330014-LPNK', 1],
      ['8630330014-LRED.jpg', '8630330014-LRED', 1],
      ['8630330014-RED.jpg', '8630330014-RED', 1],
      ['8630330015-LPUR.jpg', '8630330015-LPUR', 1],
      ['8630330015-ORG.jpg', '8630330015-ORG', 1],
      ['8630330015-PNK (2).jpg', '8630330015-PNK', 2],
      ['8630330015-PNK.jpg', '8630330015-PNK', 1],
      ['8630330015-PUR.jpg', '8630330015-PUR', 1],
    ]);
  });
});
