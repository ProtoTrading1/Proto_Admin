import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncLoaderColourVariantGroup } from '../src/lib/productLoaderApi.js';

describe('Product Loader colour family grouping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates one primary card with unique colour variants and keeps gallery copies out of the selector', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, grouped: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await syncLoaderColourVariantGroup([
      {
        code: '8630330015-LPUR',
        positillCode: '8630330015',
        variantLabel: 'Light Purple',
        title: 'LIP GLOSS GLITTER IMAN OF NOBLE | Light Purple',
        isColourVariant: true,
      },
      { code: '8630330015-ORG', positillCode: '8630330015', variantLabel: 'Orange', isColourVariant: true },
      { code: '8630330015-PNK', positillCode: '8630330015', variantLabel: 'Pink', isColourVariant: true, imageSlot: 1 },
      { code: '8630330015-PNK', positillCode: '8630330015', variantLabel: 'Pink', isColourVariant: true, imageSlot: 2 },
      { code: '8630330015-PUR', positillCode: '8630330015', variantLabel: 'Purple', isColourVariant: true },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/product-loader-colour-group');
    expect(JSON.parse(options.body)).toEqual({
      baseCode: '8630330015',
      title: 'LIP GLOSS GLITTER IMAN OF NOBLE | Light Purple',
      primaryWebsiteSku: '8630330015-LPUR',
      members: [
        { sku: '8630330015-LPUR', variantLabel: 'Light Purple', sortOrder: 0 },
        { sku: '8630330015-ORG', variantLabel: 'Orange', sortOrder: 1 },
        { sku: '8630330015-PNK', variantLabel: 'Pink', sortOrder: 2 },
        { sku: '8630330015-PUR', variantLabel: 'Purple', sortOrder: 3 },
      ],
    });
  });
});
