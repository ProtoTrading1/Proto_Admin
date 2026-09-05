import { Jimp } from 'jimp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectRemovedLightContent,
  downloadFalOutput,
  FAL_BACKGROUND_MODEL,
  FAL_TARGETED_REPAIR_MODEL,
  reconstructTargetedRegionWithFal,
  removeBackgroundWithFal,
  resolveImageTreatment,
  standardizeFalOutput,
  validateTargetedRepairMask,
  validateFalOutputUrl,
} from '../api/_fal-image-provider.js';

const originalFalKey = process.env.FAL_KEY;

afterEach(() => {
  if (originalFalKey == null) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = originalFalKey;
});

describe('fal.ai image provider', () => {
  it('keeps credentials server-side and calls the BRIA background-removal model', async () => {
    const calls = [];
    const client = {
      config: (value) => calls.push(['config', value]),
      subscribe: async (...args) => {
        calls.push(['subscribe', ...args]);
        return { data: { image: { url: 'https://v3.fal.media/files/result.png' } }, requestId: 'req_123' };
      },
    };
    const result = await removeBackgroundWithFal('https://signed.proto.test/source.jpg', {
      client,
      credentials: 'test-secret',
    });

    expect(result).toEqual({ outputUrl: 'https://v3.fal.media/files/result.png', requestId: 'req_123' });
    expect(calls[0]).toEqual(['config', { credentials: 'test-secret' }]);
    expect(calls[1][1]).toBe(FAL_BACKGROUND_MODEL);
    expect(calls[1][2].input).toEqual({ image_url: 'https://signed.proto.test/source.jpg' });
  });

  it('rejects untrusted output hosts before downloading them', async () => {
    expect(() => validateFalOutputUrl('http://v3.fal.media/result.png')).toThrow(/unexpected output host/);
    expect(() => validateFalOutputUrl('https://attacker.example/result.png')).toThrow(/unexpected output host/);
    await expect(downloadFalOutput('https://attacker.example/result.png', {
      fetchImpl: async () => { throw new Error('must not fetch'); },
    })).rejects.toThrow(/unexpected output host/);
  });

  it('fails safely when the preview does not have FAL_KEY', async () => {
    delete process.env.FAL_KEY;
    await expect(removeBackgroundWithFal('https://signed.proto.test/source.jpg')).rejects.toThrow(
      'FAL_KEY is not configured for this preview environment',
    );
  });

  it('retains a transparent master and exports a separate centred 1600px white website JPEG', async () => {
    const transparent = new Jimp({ width: 160, height: 120, color: 0x00000000 });
    for (let y = 20; y < 100; y += 1) {
      for (let x = 50; x < 110; x += 1) transparent.setPixelColor(0x204060ff, x, y);
    }
    const png = await transparent.getBuffer('image/png');
    const result = await standardizeFalOutput(png);
    const transparentMaster = await Jimp.read(result.transparentMasterBuffer);
    const output = await Jimp.read(result.websiteReadyBuffer);

    expect(output.bitmap).toMatchObject({ width: 1600, height: 1600 });
    expect(result.websiteReady).toMatchObject({ width: 1600, height: 1600, format: 'image/jpeg', background: '#FFFFFF' });
    expect(result.transparentMaster).toMatchObject({ format: 'image/png', background: 'transparent' });
    expect(result.websiteReadyBuffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const corner = output.getPixelColor(0, 0);
    expect((corner >>> 24) & 0xff).toBeGreaterThan(245);
    expect((corner >>> 16) & 0xff).toBeGreaterThan(245);
    expect((corner >>> 8) & 0xff).toBeGreaterThan(245);
    expect((transparentMaster.getPixelColor(0, 0) >>> 24) & 0xff).toBe(0);
  });

  it('blocks a cut-out that removes an interior light label while ignoring a normal white background', async () => {
    const source = new Jimp({ width: 160, height: 120, color: 0x303030ff });
    const cutout = new Jimp({ width: 160, height: 120, color: 0x00000000 });
    for (let y = 20; y < 100; y += 1) {
      for (let x = 20; x < 65; x += 1) {
        source.setPixelColor(0x2050a0ff, x, y);
        cutout.setPixelColor(0x2050a0ff, x, y);
      }
      for (let x = 90; x < 125; x += 1) source.setPixelColor(0xf6f3edff, x, y);
    }
    const damaged = await detectRemovedLightContent(
      await source.getBuffer('image/png'),
      await cutout.getBuffer('image/png'),
      { sampleSize: 160 },
    );
    expect(damaged.suspicious).toBe(true);
    expect(damaged.regions[0]).toMatchObject({ width: 35, height: 80 });

    const whiteSource = new Jimp({ width: 160, height: 120, color: 0xffffffff });
    for (let y = 30; y < 90; y += 1) for (let x = 50; x < 110; x += 1) {
      whiteSource.setPixelColor(0x2050a0ff, x, y);
      cutout.setPixelColor(0x2050a0ff, x, y);
    }
    const clean = await detectRemovedLightContent(
      await whiteSource.getBuffer('image/png'),
      await cutout.getBuffer('image/png'),
      { sampleSize: 160 },
    );
    expect(clean.suspicious).toBe(false);

    const opaqueWhiteCutout = new Jimp({ width: 160, height: 120, color: 0xffffffff });
    for (let y = 20; y < 100; y += 1) for (let x = 20; x < 65; x += 1) {
      opaqueWhiteCutout.setPixelColor(0x2050a0ff, x, y);
    }
    const opaqueDamaged = await detectRemovedLightContent(
      await source.getBuffer('image/png'),
      await opaqueWhiteCutout.getBuffer('image/png'),
      { sampleSize: 160 },
    );
    expect(opaqueDamaged.suspicious).toBe(true);
  });

  it('routes clear packaging, beads, and multi-piece products away from destructive generic removal', () => {
    for (const treatment of ['transparent_clear', 'beads_fine_detail', 'multi_piece']) {
      expect(resolveImageTreatment({ treatment })).toMatchObject({
        id: treatment,
        mode: 'preserve_source',
        removeBackground: false,
        allowAutomaticProcessing: false,
        requiresManualSafeCutout: true,
        preserve: { labels: true, text: true, quantity: true, productParts: true },
      });
      expect(resolveImageTreatment({ treatment, manualSafeCutout: true })).toMatchObject({
        id: treatment,
        mode: 'background_remove',
        removeBackground: true,
        requiresManualSafeCutout: false,
      });
    }
    expect(resolveImageTreatment({ treatment: 'measurements' })).toMatchObject({ mode: 'preserve_source', removeBackground: false });
    expect(resolveImageTreatment({ treatment: 'shadow' })).toMatchObject({ mode: 'background_remove', addShadow: true });
    expect(resolveImageTreatment({ instructions: 'Keep every one of the 12 beads visible' })).toMatchObject({ id: 'beads_fine_detail' });
  });

  it('maps a red-box selection against the exact displayed asset geometry', () => {
    const geometry = validateTargetedRepairMask({
      assetId: 'processed:img_1:run_3',
      assetWidth: 1600,
      assetHeight: 1600,
      displayRect: { x: 100, y: 50, width: 800, height: 800 },
      selection: { x: 300, y: 250, width: 160, height: 120 },
    });
    expect(geometry).toMatchObject({
      assetId: 'processed:img_1:run_3',
      coordinateSpace: 'displayed_image',
      normalized: { x: 0.25, y: 0.25, width: 0.2, height: 0.15 },
      pixels: { x: 400, y: 400, width: 320, height: 240 },
    });
    expect(() => validateTargetedRepairMask({
      assetId: 'img', assetWidth: 1600, assetHeight: 1600,
      displayRect: { x: 100, y: 50, width: 800, height: 800 },
      selection: { x: 50, y: 50, width: 100, height: 100 },
    })).toThrow(/inside the displayed image/);
    expect(() => validateTargetedRepairMask({
      assetId: 'img', assetWidth: 1600, assetHeight: 1600,
      displayRect: { x: 0, y: 0, width: 800, height: 800 },
      selection: { x: 0, y: 0, width: 700, height: 700 },
    })).toThrow(/too large/);
  });

  it('runs targeted reconstruction only with a current validated asset and preservation prompt', async () => {
    const calls = [];
    const client = {
      config: (value) => calls.push(['config', value]),
      subscribe: async (...args) => {
        calls.push(['subscribe', ...args]);
        return { data: { images: [{ url: 'https://v3.fal.media/files/repaired.png' }] }, requestId: 'repair_1' };
      },
    };
    const geometry = validateTargetedRepairMask({
      assetId: 'processed:run_4', assetWidth: 1600, assetHeight: 1600,
      displayRect: { x: 0, y: 0, width: 800, height: 800 },
      selection: { x: 100, y: 100, width: 100, height: 80 },
    });
    const result = await reconstructTargetedRegionWithFal(
      'https://storage.test/source.png', 'https://storage.test/mask.png', geometry,
      { client, credentials: 'test-secret', currentAssetId: 'processed:run_4' },
    );
    expect(result.outputUrl).toBe('https://v3.fal.media/files/repaired.png');
    expect(calls[1][1]).toBe(FAL_TARGETED_REPAIR_MODEL);
    expect(calls[1][2].input.prompt).toContain('preserve every product part');
    expect(calls[1][2].input.prompt).toContain('exact pack quantity');
    await expect(reconstructTargetedRegionWithFal(
      'https://storage.test/source.png', 'https://storage.test/mask.png', geometry,
      { client, credentials: 'test-secret', currentAssetId: 'processed:new-run' },
    )).rejects.toThrow(/displayed image changed/);
  });
});
