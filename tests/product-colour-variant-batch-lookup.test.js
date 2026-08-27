import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  lookupWebsiteStockExact,
  resolveProductLoaderMatch,
} = vi.hoisted(() => ({
  lookupWebsiteStockExact: vi.fn(),
  resolveProductLoaderMatch: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({}),
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
    fetchDormantSkuSet: vi.fn(async () => new Set()),
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
