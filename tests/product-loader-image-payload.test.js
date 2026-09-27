import { describe, expect, it, vi } from 'vitest';
import {
  INSTORE_INLINE_IMAGE_MAX_BYTES,
  lookupFilenames,
  prepareLocalShipmentImage,
} from '../src/lib/productLoaderApi.js';

describe('landed-shipment image payload preparation', () => {
  it('keeps a small image unchanged', async () => {
    const file = { name: '8623100236.png', type: 'image/png', size: 300_000 };
    const compress = vi.fn();

    await expect(prepareLocalShipmentImage(file, { compress })).resolves.toEqual({
      file,
      filename: '8623100236.png',
      contentType: 'image/png',
      compressed: false,
    });
    expect(compress).not.toHaveBeenCalled();
  });

  it('compresses an oversized wallet photo before the API request', async () => {
    const file = { name: '8623100236.PNG', type: 'image/png', size: 5_000_000 };
    const prepared = { size: 420_000 };
    const compress = vi.fn().mockResolvedValue(prepared);

    await expect(prepareLocalShipmentImage(file, { compress })).resolves.toEqual({
      file: prepared,
      filename: '8623100236.jpg',
      contentType: 'image/jpeg',
      compressed: true,
    });
    expect(compress).toHaveBeenCalledWith(file);
  });

  it('fails before fetch when compression cannot make the request safe', async () => {
    const file = { name: '8623100236.jpg', type: 'image/jpeg', size: 6_000_000 };
    const compress = vi.fn().mockResolvedValue({ size: INSTORE_INLINE_IMAGE_MAX_BYTES + 1 });

    await expect(prepareLocalShipmentImage(file, { compress })).rejects.toThrow(/below 1\.5 MB/);
  });

  it('keeps a copied landed image on the same Positill SKU, without a sibling publish code', async () => {
    const filename = '8626000775 (2).jpg';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ items: [{ filename, code: '8626000775', canPublish: true, group: 'ready' }] }),
    })));
    try {
      const file = { name: filename };
      const [landed] = await lookupFilenames([filename], [file], { strictExact: true, groupColourVariants: false });
      const [website] = await lookupFilenames([filename], [file], { strictExact: false, groupColourVariants: false });
      expect(landed.publishSku).toBe('8626000775');
      expect(website.publishSku).toBe('8626000775-2');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
