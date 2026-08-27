import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import {
  applyArchivedImage,
  archiveApprovedImage,
  assertCompletedCleanQuality,
  assertProductionImageMutation,
  createTargetedRepairRevision,
  isStockStagingOutputOwnedBy,
  markImageApproved,
  restorePublishedOriginal,
  removeExactWorkerStagingOutput,
  targetedRepairAssetId,
} from '../api/_image-processing-service.js';
import { isPrivateImageArtifactOwnedBy } from '../api/_image-processing-store.js';
import { productManagerDestination } from '../lib/image-processing-centre.mjs';

const cleanQuality = { score: 98, grade: 'excellent' };

function archivedImage(overrides = {}) {
  return {
    id: 'img_1',
    sku: 'ABC1',
    slot: 1,
    targetTable: 'website_stock',
    destination: productManagerDestination({ sku: 'ABC1', slot: 1 }),
    status: 'archived',
    source: { type: 'local_upload', filename: 'ABC1.jpg' },
    quality: cleanQuality,
    warnings: [],
    reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
    archive: {
      assetId: 'asset_ipc_1_img_1',
      websiteReadyPath: 'image-processing/sources/ipc_1/img_1-run-1-website-ready.jpg',
      destinationSnapshot: {
        ...productManagerDestination({ sku: 'ABC1', slot: 1 }),
        expectedLiveUrl: null,
        capturedAt: '2026-08-10T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

function stockHarness({ liveUrl = null, updateRows = [{ sku: 'ABC1' }], auditError = null } = {}) {
  const calls = { uploads: [], updates: [], audits: [] };
  const productTable = {
    select() {
      const query = {
        eq: () => query,
        limit: async () => ({ data: [{ sku: 'ABC1', title: 'Product', image_url_one: liveUrl }], error: null }),
      };
      return query;
    },
    update(values) {
      calls.updates.push(values);
      const query = {
        eq: () => query,
        is: () => query,
        select: async () => ({ data: updateRows, error: null }),
      };
      return query;
    },
  };
  const bucket = {
    upload: async (path) => { calls.uploads.push(path); return { error: null }; },
    list: async () => ({ data: [], error: null }),
    getPublicUrl: (path) => ({ data: { publicUrl: `https://images.example/${path}` } }),
  };
  const stock = {
    from(table) {
      if (table === 'website_stock') return productTable;
      if (table === 'product_publish_audit') {
        return {
          insert: async (payload) => {
            calls.audits.push(payload);
            return { error: auditError };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: { from: () => bucket },
  };
  return { calls, stock };
}

describe('Image Processing Centre production mutation safety', () => {
  it('allows live mutation only when Vercel explicitly identifies production', () => {
    for (const environment of [undefined, '', 'development', 'preview']) {
      expect(() => assertProductionImageMutation(environment)).toThrow(/physically blocked/i);
    }
    expect(() => assertProductionImageMutation('production')).not.toThrow();
  });

  it('blocks preview apply before storage, audit, or website_stock can be touched', async () => {
    const { stock, calls } = stockHarness();
    const image = archivedImage();
    await expect(applyArchivedImage({ id: 'ipc_1', images: [image] }, image, {
      actor: 'owner@proto.co.za',
      stockClient: stock,
      confirmArchiveAssetId: image.archive.assetId,
      deploymentEnv: 'preview',
      loadArchivedSource: async () => Buffer.from('image'),
    })).rejects.toMatchObject({ code: 'ipc_production_only' });
    expect(calls).toMatchObject({ uploads: [], updates: [], audits: [] });
  });

  it('requires completed clean quality and explicit acknowledgement of manual treatment advisories', async () => {
    expect(() => markImageApproved({ id: 'img', status: 'review' }, {
      actor: 'owner', reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
    }))
      .toThrow(/must complete/i);
    expect(() => assertCompletedCleanQuality({ quality: { score: 70, grade: 'fair' } }))
      .toThrow(/not clean enough/i);
    expect(() => assertCompletedCleanQuality({ quality: { ...cleanQuality, flags: ['edge_halo'] } }))
      .toThrow(/quality warning/i);
    expect(() => assertCompletedCleanQuality({
      quality: { ...cleanQuality, grade: 'needs_attention', flags: ['possible_detached_label_or_barcode', 'manual_label_barcode_review_required'] },
    })).not.toThrow();
    expect(() => markImageApproved({
      id: 'img', status: 'review', quality: cleanQuality,
      warnings: ['transparent_edges_and_print_must_be_visually_verified'],
    }, {
      actor: 'owner',
      reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
    })).toThrow(/treatment-specific/i);
  });

  it('blocks approval when preservation detects removed light product content, even with a high raw score', () => {
    const beadImage = {
      id: 'bead-img',
      status: 'review',
      quality: {
        ...cleanQuality,
        // The preservation detector intentionally downgrades this result in
        // production, but keep the raw score high here to prove the warning
        // itselfâ€”not score roundingâ€”remains an approval gate.
        score: 98,
        grade: 'excellent',
        flags: ['possible_removed_label_or_light_product_part'],
        requiresManualReview: true,
      },
      warnings: ['possible_removed_label_or_light_product_part'],
    };
    expect(() => markImageApproved(beadImage, {
      actor: 'owner',
      reviewChecklist: {
        correctSku: true,
        labelsPreserved: true,
        cleanEdgesBackground: true,
      },
    })).toThrow(/not clean enough|quality warning|unresolved processing warnings/i);
  });

  it('captures the exact live Product Manager image when an approved result is archived', async () => {
    const { stock } = stockHarness({ liveUrl: 'https://images.example/current.jpg' });
    const approved = {
      ...archivedImage(),
      status: 'approved',
      archive: null,
      reviewChecklist: { correctSku: true, labelsPreserved: true, cleanEdgesBackground: true },
      processed: { transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-run-1-transparent-master.png' },
      outputStoragePath: 'image-processing/sources/ipc_1/img_1-run-1-website-ready.jpg',
      source: { type: 'local_upload', filename: 'ABC1.jpg', privatePath: 'image-processing/sources/ipc_1/img_1.jpg' },
    };
    const archived = await archiveApprovedImage({ id: 'ipc_1', images: [approved] }, approved, {
      actor: 'owner@proto.co.za', stockClient: stock,
    });
    expect(archived.archive.destinationSnapshot).toMatchObject({
      sku: 'ABC1', field: 'image_url_one', expectedLiveUrl: 'https://images.example/current.jpg',
    });
  });

  it('still saves a private archive asset when the inferred Product Manager SKU is not found', async () => {
    const stock = {
      from() {
        return {
          select() {
            const query = { eq: () => query, limit: async () => ({ data: [], error: null }) };
            return query;
          },
        };
      },
    };
    const approved = {
      ...archivedImage(),
      status: 'approved',
      archive: null,
      processed: { transparentPrivatePath: 'image-processing/sources/ipc_1/img_1-run-1-transparent-master.png' },
      outputStoragePath: 'image-processing/sources/ipc_1/img_1-run-1-website-ready.jpg',
      source: { type: 'local_upload', filename: 'ABC1.jpg', privatePath: 'image-processing/sources/ipc_1/img_1.jpg' },
    };
    const archived = await archiveApprovedImage({ id: 'ipc_1', images: [approved] }, approved, {
      actor: 'owner@proto.co.za', stockClient: stock,
    });
    expect(archived.status).toBe('archived');
    expect(archived.archive.destinationSnapshot.lookupUnavailable).toBe(true);
  });

  it('refuses a stale archive after the live image changes and does not upload or audit', async () => {
    const { stock, calls } = stockHarness({ liveUrl: 'https://images.example/newer.jpg' });
    const image = archivedImage();
    await expect(applyArchivedImage({ id: 'ipc_1', images: [image] }, image, {
      actor: 'owner@proto.co.za', stockClient: stock,
      confirmArchiveAssetId: image.archive.assetId,
      deploymentEnv: 'production',
      allowOverwrite: true,
      loadArchivedSource: async () => Buffer.from('image'),
    })).rejects.toMatchObject({ code: 'ipc_product_image_conflict' });
    expect(calls).toMatchObject({ uploads: [], updates: [], audits: [] });
  });

  it('requires the exact archive confirmation even in production', async () => {
    const { stock, calls } = stockHarness();
    const image = archivedImage();
    await expect(applyArchivedImage({ id: 'ipc_1', images: [image] }, image, {
      actor: 'owner@proto.co.za', stockClient: stock, deploymentEnv: 'production',
    })).rejects.toMatchObject({ code: 'ipc_archive_confirmation_required' });
    expect(calls).toMatchObject({ uploads: [], updates: [], audits: [] });
  });

  it('lets an approved revision safely supersede its archived parent in the same slot', async () => {
    const { stock, calls } = stockHarness();
    const parent = archivedImage();
    const revision = archivedImage({
      id: 'img_1-rev-2-abcd',
      archive: {
        ...parent.archive,
        assetId: 'asset_ipc_1_img_1-rev-2-abcd',
        websiteReadyPath: 'image-processing/sources/ipc_1/img_1-rev-2-abcd-website-ready.jpg',
        supersedesAssetId: parent.archive.assetId,
      },
      revision: { rootImageId: 'img_1', parentImageId: 'img_1', number: 2 },
    });
    const published = await applyArchivedImage({ id: 'ipc_1', images: [parent, revision] }, revision, {
      actor: 'owner@proto.co.za', stockClient: stock,
      confirmArchiveAssetId: revision.archive.assetId,
      deploymentEnv: 'production',
      loadArchivedSource: async () => Buffer.from('image'),
    });
    expect(published.status).toBe('published');
    expect(calls.uploads).toHaveLength(1);
    expect(calls.updates).toHaveLength(1);
    expect(calls.audits.length).toBeGreaterThanOrEqual(2);
  });

  it('requires an audit authorization record before uploading or mutating Product Manager', async () => {
    const { stock, calls } = stockHarness();
    const image = archivedImage();
    const auditWriter = vi.fn().mockRejectedValue(new Error('audit unavailable'));
    await expect(applyArchivedImage({ id: 'ipc_1', images: [image] }, image, {
      actor: 'owner@proto.co.za', stockClient: stock,
      confirmArchiveAssetId: image.archive.assetId,
      deploymentEnv: 'production',
      loadArchivedSource: async () => Buffer.from('image'),
      auditWriter,
    })).rejects.toThrow(/audit unavailable/);
    expect(calls.uploads).toEqual([]);
    expect(calls.updates).toEqual([]);
  });

  it('blocks preview restore before it can inspect or mutate Product Manager', async () => {
    const { stock, calls } = stockHarness();
    const image = archivedImage({
      status: 'published',
      publishedUrl: 'https://images.example/current.jpg',
      publication: {
        ...productManagerDestination({ sku: 'ABC1', slot: 1 }),
        liveUrl: 'https://images.example/current.jpg',
        originalUrl: null,
      },
    });
    await expect(restorePublishedOriginal({ id: 'ipc_1' }, image, {
      actor: 'owner@proto.co.za', stockClient: stock, deploymentEnv: 'preview',
    })).rejects.toMatchObject({ code: 'ipc_production_only' });
    expect(calls).toMatchObject({ uploads: [], updates: [], audits: [] });
  });

  it('recognizes only exact job-and-image-owned private artifacts for cleanup', () => {
    const job = { id: 'ipc_1' };
    const revision = { id: 'img_1-rev-2-abcd' };
    expect(isPrivateImageArtifactOwnedBy(job, revision, 'image-processing/sources/ipc_1/img_1-rev-2-abcd-website-ready.jpg')).toBe(true);
    expect(isPrivateImageArtifactOwnedBy(job, revision, 'image-processing/sources/ipc_1/img_1-transparent-master.png')).toBe(false);
    expect(isPrivateImageArtifactOwnedBy(job, revision, 'image-processing/sources/ipc_2/img_1-rev-2-abcd-website-ready.jpg')).toBe(false);
    expect(isPrivateImageArtifactOwnedBy(job, revision, 'image-processing/sources/ipc_1/img_10-rev-2-abcd-website-ready.jpg')).toBe(false);
  });

  it('deletes only the exact recorded unique stock-staging output for the job run', () => {
    const job = { id: 'ipc_1' };
    const image = {
      id: 'img_1',
      processing: {
        runId: 'run-abc-123',
        outputPath: 'staging/image-processing/outputs/ipc_1/img_1-run-abc-123.jpg',
      },
    };
    expect(isStockStagingOutputOwnedBy(job, image, image.processing.outputPath)).toBe(true);
    expect(isStockStagingOutputOwnedBy(job, image, 'staging/image-processing/outputs/ipc_1/img_1-other-run.jpg')).toBe(false);
    expect(isStockStagingOutputOwnedBy(job, image, 'staging/image-processing/outputs/ipc_2/img_1-run-abc-123.jpg')).toBe(false);
    expect(isStockStagingOutputOwnedBy(job, image, 'staging/image-processing/outputs/ipc_1/img_10-run-abc-123.jpg')).toBe(false);
    expect(isStockStagingOutputOwnedBy(job, {
      ...image,
      processing: { ...image.processing, outputPath: '../../ABC1/1.jpg' },
    }, '../../ABC1/1.jpg')).toBe(false);
  });

  it('removes the exact public worker staging object and fails closed when removal fails', async () => {
    const job = { id: 'ipc_1' };
    const image = {
      id: 'img_1',
      processing: {
        runId: 'run-abc-123',
        outputPath: 'staging/image-processing/outputs/ipc_1/img_1-run-abc-123.jpg',
      },
    };
    const remove = vi.fn().mockResolvedValue({ error: null });
    await removeExactWorkerStagingOutput({ remove }, job, image, image.processing.outputPath);
    expect(remove).toHaveBeenCalledWith([image.processing.outputPath]);

    const failedRemove = vi.fn().mockResolvedValue({ error: { message: 'storage unavailable' } });
    await expect(removeExactWorkerStagingOutput(
      { remove: failedRemove }, job, image, image.processing.outputPath,
    )).rejects.toMatchObject({ code: 'ipc_staging_cleanup_failed' });
    expect(failedRemove).toHaveBeenCalledWith([image.processing.outputPath]);
  });

  it('rejects a stale red-box repair and creates only a separate review revision for the current asset', async () => {
    const parent = {
      ...archivedImage(),
      status: 'review',
      archive: null,
      outputStoragePath: 'image-processing/sources/ipc_1/img_1-run-1-website-ready.jpg',
      processing: { runId: 'run-1' },
    };
    const job = { id: 'ipc_1', images: [parent] };
    const displayed = await new Jimp({ width: 100, height: 100, color: 0xffffffff }).getBuffer('image/png');
    const provider = vi.fn().mockResolvedValue({ outputUrl: 'https://fal.media/repaired.png', requestId: 'repair-1' });
    const common = {
      actor: 'owner@proto.co.za',
      displayRect: { x: 0, y: 0, width: 100, height: 100 },
      selection: { x: 5, y: 5, width: 20, height: 20 },
      loadAsset: async () => displayed,
      storeAsset: async ({ imageId }) => `image-processing/sources/ipc_1/${imageId}.png`,
      createAssetUrl: async (path) => `https://private.example/${encodeURIComponent(path)}`,
      repairProvider: provider,
      downloadRepairOutput: async () => displayed,
    };
    await expect(createTargetedRepairRevision(job, parent, {
      ...common, displayedAssetId: 'stale-asset',
    })).rejects.toMatchObject({ code: 'ipc_repair_stale_asset' });
    expect(provider).not.toHaveBeenCalled();

    const revision = await createTargetedRepairRevision(job, parent, {
      ...common, displayedAssetId: targetedRepairAssetId(job, parent),
    });
    expect(parent).toMatchObject({ id: 'img_1', status: 'review' });
    expect(revision).toMatchObject({
      status: 'review', archive: null,
      revision: { parentImageId: 'img_1', action: 'targeted_repair', audit: { preservedParent: true, liveMutation: false } },
    });
    expect(revision.id).not.toBe(parent.id);
    expect(revision).not.toHaveProperty('publishedUrl');
    expect(revision.processed.transparentPrivatePath).toContain(revision.id);
  });
});

