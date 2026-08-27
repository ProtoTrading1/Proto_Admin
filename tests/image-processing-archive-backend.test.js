import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  applyArchivedImage,
  archiveApprovedImage,
  createWebsiteReadyDerivative,
  // Revision creation is kept in its own module so it cannot change a live
  // Product Manager image or mutate the archived parent.
  markImageApproved,
  publishApprovedImage,
} from '../api/_image-processing-service.js';
import { createArchiveRevision, createArchiveRevisionDerivative } from '../api/_image-processing-revisions.js';
import { IMAGE_STATUSES, deriveJobStatus } from '../lib/image-processing-centre.mjs';

function archiveStorage() {
  const copies = [];
  const bucket = {
    copy: async (...args) => { copies.push(args); return { error: null }; },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://images.example/${path}` } }),
  };
  const product = {
    select: () => {
      const query = {
        eq: () => query,
        limit: async () => ({ data: [{ sku: 'ABC1', title: 'Product', image_url_one: null }], error: null }),
      };
      return query;
    },
  };
  return { copies, client: { from: () => product, storage: { from: () => bucket } } };
}

describe('Image Processing Centre archive-first backend', () => {
  it('uses a distinct archived state and treats an archived batch as complete', () => {
    expect(IMAGE_STATUSES).toContain('archived');
    expect(deriveJobStatus([{ status: 'archived' }])).toBe('complete');
  });

  it('creates a 1600px white JPEG derivative from a transparent master', async () => {
    const transparent = new Jimp({ width: 40, height: 20, color: 0x00000000 });
    transparent.setPixelColor(0x223344ff, 20, 10);
    const result = await createWebsiteReadyDerivative(await transparent.getBuffer('image/png'));
    const websiteReady = await Jimp.read(result.buffer);

    expect(result).toMatchObject({ width: 1600, height: 1600, background: '#FFFFFF', format: 'jpeg' });
    expect(websiteReady.bitmap).toMatchObject({ width: 1600, height: 1600 });
    expect(websiteReady.getPixelColor(0, 0) >>> 8).toBe(0xffffff);
  });

  it('contains and centers a non-square worker output on the white 1600px canvas', async () => {
    const workerOutput = new Jimp({ width: 800, height: 400, color: 0x00000000 });
    workerOutput.setPixelColor(0x223344ff, 400, 200);
    const result = await createWebsiteReadyDerivative(await workerOutput.getBuffer('image/png'));
    const websiteReady = await Jimp.read(result.buffer);

    expect(websiteReady.bitmap).toMatchObject({ width: 1600, height: 1600 });
    expect(websiteReady.getPixelColor(0, 0) >>> 8).toBe(0xffffff);
    expect(websiteReady.getPixelColor(800, 800) >>> 8).not.toBe(0xffffff);
  });

  it('archives only an approved image that has both private and website-ready versions', async () => {
    const { client, copies } = archiveStorage();
    const archived = await archiveApprovedImage({ id: 'ipc_1' }, {
      id: 'img_1', status: 'approved', source: { privatePath: 'image-processing/sources/ipc_1/img_1.jpg' },
      processed: { transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-transparent-master.png' },
      outputStoragePath: 'image-processing/sources/ipc_1/img_1-website-ready.jpg',
      sku: 'ABC1', slot: 1, targetTable: 'website_stock',
      quality: { score: 98, grade: 'excellent' }, warnings: [],
      reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
    }, { actor: 'owner@proto.co.za', stockClient: client });

    expect(copies).toEqual([]);
    expect(archived).toMatchObject({
      status: 'archived',
      archive: {
        originalPrivatePath: 'image-processing/sources/ipc_1/img_1.jpg',
        transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-transparent-master.png',
        websiteReadyPath: 'image-processing/sources/ipc_1/img_1-website-ready.jpg',
        specification: { width: 1600, height: 1600, background: '#FFFFFF', format: 'jpeg' },
      },
    });
  });

  it('does not let approval or the old direct-publish entry point change Product Manager', async () => {
    const approved = markImageApproved({
      id: 'img_1', status: 'review', reviewUrl: '/review.jpg',
      quality: { score: 98, grade: 'excellent' }, warnings: [],
    }, {
      actor: 'owner@proto.co.za',
      reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
    });
    expect(approved).toMatchObject({ status: 'approved', reviewUrl: '/review.jpg' });
    expect(approved).not.toHaveProperty('archive');
    await expect(publishApprovedImage()).rejects.toMatchObject({ code: 'archive_required' });
  });

  it('requires an archived asset for the future explicit Product Manager application', async () => {
    await expect(applyArchivedImage({ id: 'ipc_1', images: [] }, {
      id: 'img_1', status: 'approved', slot: 1,
    }, { actor: 'owner@proto.co.za', deploymentEnv: 'production' })).rejects.toThrow(/explicitly archived/i);
  });

  it('creates a separately reviewable white-canvas revision from the retained master without changing its archive parent', async () => {
    const transparent = new Jimp({ width: 100, height: 40, color: 0x00000000 });
    transparent.setPixelColor(0x334455ff, 50, 20);
    const master = await transparent.getBuffer('image/png');
    const stored = [];
    const parent = {
      id: 'img_1', status: 'archived', sku: 'ABC1', slot: 1,
      source: { filename: 'ABC1.jpg', privatePath: 'image-processing/sources/ipc_1/img_1.jpg' },
      processed: { transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-master.png' },
      archive: { transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-master.png', assetId: 'asset_ipc_1_img_1' },
    };
    const revision = await createArchiveRevision({ id: 'ipc_1' }, parent, {
      actor: 'owner@proto.co.za',
      adjustments: { paddingRatio: 0.12, background: '#FFFFFF', shadow: 'soft' },
      loadMaster: async () => master,
      storeDerivative: async (input) => { stored.push(input); return `image-processing/sources/ipc_1/${input.imageId}.jpg`; },
    });

    expect(parent.status).toBe('archived');
    expect(parent.archive.assetId).toBe('asset_ipc_1_img_1');
    expect(revision).toMatchObject({
      status: 'review', archive: null,
      quality: { grade: 'excellent' },
      revision: { parentImageId: 'img_1', number: 2, adjustments: { paddingRatio: 0.12, background: '#FFFFFF', shadow: 'soft' } },
    });
    expect(stored).toHaveLength(1);
    const output = await Jimp.read(stored[0].buffer);
    expect(output.bitmap).toMatchObject({ width: 1600, height: 1600 });
    expect(output.getPixelColor(0, 0) >>> 8).toBe(0xffffff);
  });

  it('rejects a non-white archive background rather than creating an inconsistent website asset', async () => {
    await expect(createArchiveRevisionDerivative(Buffer.from('not-an-image'), { background: '#000000' }))
      .rejects.toThrow(/#FFFFFF/);
  });
});

