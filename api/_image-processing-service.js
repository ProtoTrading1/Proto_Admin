import { createHash, randomUUID } from 'node:crypto';
import { Jimp } from 'jimp';
import { downloadNutstoreFile, isPathInLibrary } from './_nutstore-webdav.js';
import { getStockClient } from './_image-gen-cost.js';
import { storagePathFromPublicUrl } from './_staging-storage.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';
import {
  createPrivateSourceUrl,
  downloadPrivateSource,
  removeImageJobRecord,
  removePrivateImageArtifacts,
  saveAndIndexImageJob,
  storePrivateSource,
} from './_image-processing-store.js';
import {
  createTargetedRepairMask,
  detectRemovedLightContent,
  downloadFalOutput,
  FAL_BACKGROUND_COST_USD,
  FAL_BACKGROUND_MODEL,
  FAL_TARGETED_REPAIR_MODEL,
  FAL_USD_TO_ZAR,
  reconstructTargetedRegionWithFal,
  removeBackgroundWithFal,
  resolveImageTreatment,
  standardizeFalOutput,
  validateTargetedRepairMask,
  validateTargetedRepairMaskImage,
} from './_fal-image-provider.js';
import {
  ALLOWED_TARGET_TABLES,
  deriveJobStatus,
  normalizeImageSku,
  normalizeImageSlot,
  productManagerDestination,
  qualityScoreFromMetrics,
  summarizeJob,
} from '../lib/image-processing-centre.mjs';

const PRODUCT_BUCKET = 'product-images';

function updateJobRollup(job) {
  return {
    ...job,
    status: deriveJobStatus(job.images),
    summary: summarizeJob(job.images),
  };
}

export async function persistJob(job) {
  return saveAndIndexImageJob(updateJobRollup(job));
}

export async function ingestLocalSource(jobId, image, base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  const privatePath = await storePrivateSource({
    jobId,
    imageId: image.id,
    filename: image.source.filename,
    contentType: image.source.contentType,
    buffer,
  });
  return { ...image, source: { ...image.source, ref: null, privatePath, bytes: buffer.length } };
}

export async function ingestStagedSource(jobId, image) {
  const storagePath = storagePathFromPublicUrl(image.source.ref);
  if (!storagePath) throw new Error('Source URL must be an existing Proto product-images object');
  const stock = getStockClient();
  const { data, error } = await stock.storage.from(PRODUCT_BUCKET).download(storagePath);
  if (error) throw new Error(`Could not import staged source: ${error.message}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  const privatePath = await storePrivateSource({
    jobId,
    imageId: image.id,
    filename: image.source.filename,
    contentType: image.source.contentType,
    buffer,
  });
  return { ...image, source: { ...image.source, ref: null, privatePath, bytes: buffer.length } };
}

export async function materializeNutstoreSource(job, image) {
  if (image.source.privatePath) return image;
  if (!isPathInLibrary(image.source.ref)) throw new Error('Nutstore path is outside the configured image library');
  const downloaded = await downloadNutstoreFile(image.source.ref);
  const privatePath = await storePrivateSource({
    jobId: job.id,
    imageId: image.id,
    filename: downloaded.filename || image.source.filename,
    contentType: downloaded.contentType || image.source.contentType,
    buffer: downloaded.buffer,
  });
  return {
    ...image,
    source: {
      ...image.source,
      filename: downloaded.filename || image.source.filename,
      contentType: downloaded.contentType || image.source.contentType,
      privatePath,
      bytes: downloaded.buffer.length,
    },
  };
}

export function estimatedImageCostUsd() {
  return FAL_BACKGROUND_COST_USD;
}

export function canClaimWithinCostLimit(job, image) {
  const spent = Number(job.summary?.costUsd) || 0;
  const next = estimatedImageCostUsd(image);
  const limit = Number(job.maxCostUsd) || 0;
  return {
    allowed: limit <= 0 || (spent + next) <= (limit + 0.000001),
    spent,
    next,
    limit,
  };
}

export async function prepareWorkerClaim(job, image, { expiresIn = 600 } = {}) {
  let materialized = image;
  if (image.source.type === 'nutstore' && !image.source.privatePath) {
    materialized = await materializeNutstoreSource(job, image);
  }
  if (!materialized.source.privatePath) throw new Error('Image source is not available in private staging');

  const treatment = resolveImageTreatment(materialized);
  if (!treatment.allowAutomaticProcessing) {
    throw imageProcessingError(
      'ipc_manual_treatment_required',
      `${treatment.label} requires a verified manual treatment before automatic processing can continue.`,
    );
  }

  const sourceUrl = await createPrivateSourceUrl(materialized.source.privatePath, expiresIn);
  const detailSensitive = ['transparent_clear', 'beads_fine_detail', 'multi_piece'].includes(treatment.id);
  const stock = getStockClient();
  await stock.storage.createBucket(PRODUCT_BUCKET, { public: true }).catch(() => {});
  const runId = randomUUID();
  const outputPath = `staging/image-processing/outputs/${job.id}/${image.id}-${runId}.jpg`;
  const { data, error } = await stock.storage.from(PRODUCT_BUCKET).createSignedUploadUrl(outputPath, { upsert: true });
  if (error) throw error;

  return {
    image: materialized,
    claimState: { runId, outputPath, treatment },
    claimPayload: {
      jobId: job.id,
      imageId: image.id,
      sku: image.sku,
      slot: image.slot,
      source: {
        url: sourceUrl,
        contentType: materialized.source.contentType,
        filename: materialized.source.filename,
        expiresIn,
      },
      output: {
        path: outputPath,
        signedUploadUrl: data.signedUrl,
        token: data.token,
        contentType: 'image/jpeg',
        headers: { 'x-upsert': 'true', 'cache-control': 'max-age=0' },
      },
      processing: {
        treatment: treatment.id,
        treatment_policy: treatment,
        manual_safe_cutout: materialized.manualSafeCutout === true,
        remove_background: treatment.removeBackground,
        background: 'white',
        cleanup_noise: !detailSensitive,
        crop: !detailSensitive,
        padding_ratio: 0.08,
        width: 1600,
        height: 1600,
        output_format: 'jpeg',
        quality: 90,
        review_policy: 'manual_before_publish',
      },
      estimatedCostUsd: estimatedImageCostUsd(image),
    },
  };
}

export async function analyzeImageQuality(buffer) {
  const image = await Jimp.read(buffer);
  const { width, height, data } = image.bitmap;
  let borderPixels = 0;
  let whiteBorderPixels = 0;
  let borderDeviation = 0;
  let clippedPixels = 0;
  const borderDepth = Math.max(1, Math.round(Math.min(width, height) * 0.03));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorder = x < borderDepth || y < borderDepth || x >= width - borderDepth || y >= height - borderDepth;
      if (!isBorder) continue;
      const idx = ((y * width) + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      const transparent = alpha <= 16;
      const deviation = transparent ? 0 : ((255 - r) + (255 - g) + (255 - b)) / (3 * 255);
      borderPixels += 1;
      borderDeviation += deviation;
      if (transparent || (r >= 245 && g >= 245 && b >= 245)) whiteBorderPixels += 1;
      if (!transparent && (x === 0 || y === 0 || x === width - 1 || y === height - 1) && (r < 235 || g < 235 || b < 235)) {
        clippedPixels += 1;
      }
    }
  }

  const metrics = {
    width,
    height,
    bytes: buffer.length,
    whiteBorderRatio: borderPixels ? whiteBorderPixels / borderPixels : 0,
    borderNoise: borderPixels ? borderDeviation / borderPixels : 1,
    clippedEdgeRatio: clippedPixels / Math.max(1, (width * 2) + (height * 2) - 4),
  };
  return { ...metrics, ...qualityScoreFromMetrics(metrics) };
}

// The cut-out is retained privately as the reusable master. The review and
// archive derivative is deliberately what the customer will see: a consistent
// 1600 Ã— 1600 white JPEG, rather than a transparent image on an unknown page.
export async function createWebsiteReadyDerivative(masterBuffer, { size = 1600 } = {}) {
  const master = await Jimp.read(masterBuffer);
  const targetSize = Math.max(1, Math.round(Number(size) || 1600));
  const scale = Math.min(1, targetSize / master.bitmap.width, targetSize / master.bitmap.height);
  const contained = scale < 1
    ? master.clone().resize({ w: Math.max(1, Math.round(master.bitmap.width * scale)), h: Math.max(1, Math.round(master.bitmap.height * scale)) })
    : master;
  const canvas = new Jimp({ width: targetSize, height: targetSize, color: 0xffffffff });
  canvas.composite(contained, Math.round((targetSize - contained.bitmap.width) / 2), Math.round((targetSize - contained.bitmap.height) / 2));
  const buffer = await canvas.getBuffer('image/jpeg');
  return { buffer, width: targetSize, height: targetSize, background: '#FFFFFF', format: 'jpeg' };
}

async function storeTransparentMaster(job, image, buffer, runId) {
  return storePrivateSource({
    jobId: job.id,
    imageId: `${image.id}-run-${runId}-transparent-master`,
    filename: `${image.id}-run-${runId}-transparent-master.png`,
    contentType: 'image/png',
    buffer,
  });
}

async function uploadWebsiteReadyDerivative(job, image, buffer, runId) {
  // The review derivative is an archive asset, not catalogue media.  Keep it
  // in the private site-config bucket until the operator explicitly applies it
  // to Product Manager, at which point only the final copy becomes public.
  const path = await storePrivateSource({
    jobId: job.id,
    imageId: `${image.id}-run-${runId}-website-ready`,
    filename: `${image.id}-run-${runId}-1600-white.jpg`,
    contentType: 'image/jpeg',
    buffer,
  });
  return { path, url: null };
}

export async function completeWorkerOutput(job, image, payload = {}) {
  const expectedPath = image.processing?.outputPath;
  if (!expectedPath) throw new Error('Worker claim is missing its unique output path');
  if (String(payload.outputPath || '') !== expectedPath) throw new Error('Worker output path does not match the claim');
  const runId = image.processing?.runId;
  if (!runId) throw new Error('Worker claim is missing its unique run ID');
  const stock = getStockClient();
  const { data, error } = await stock.storage.from(PRODUCT_BUCKET).download(expectedPath);
  if (error) throw new Error(`Worker output was not uploaded: ${error.message}`);
  const transparentMaster = Buffer.from(await data.arrayBuffer());
  const transparentPrivatePath = await storeTransparentMaster(job, image, transparentMaster, runId);
  const websiteReady = await createWebsiteReadyDerivative(transparentMaster);
  const websiteReadyStorage = await uploadWebsiteReadyDerivative(job, image, websiteReady.buffer, runId);
  const quality = await analyzeImageQuality(websiteReady.buffer);
  const workerWarnings = Array.isArray(payload.warnings)
    ? payload.warnings.map((warning) => String(warning).slice(0, 120)).slice(0, 20)
    : [];
  const ambiguousLabelWarning = workerWarnings.includes('possible_detached_label_or_barcode')
    ? ['manual_label_barcode_review_required']
    : [];
  await removeExactWorkerStagingOutput(
    stock.storage.from(PRODUCT_BUCKET),
    job,
    image,
    expectedPath,
  );
  return {
    ...image,
    status: 'review',
    reviewUrl: websiteReadyStorage.url,
    outputStoragePath: websiteReadyStorage.path,
    processed: {
      transparentPrivatePath,
      websiteReady: { ...websiteReadyStorage, ...websiteReady },
    },
    quality: { ...quality, worker: payload.quality || null },
    warnings: [...new Set([...(image.warnings || []), ...workerWarnings, ...ambiguousLabelWarning])],
    cost: {
      usd: 0,
      zar: 0,
      latestUsd: 0,
      latestZar: 0,
      source: 'self_hosted_fixed_overhead',
      model: 'rembg-local',
    },
    processing: { ...(image.processing || {}), finishedAt: new Date().toISOString() },
    error: null,
  };
}

export async function processImageWithFal(job, image, providerOptions = {}) {
  let materialized = image;
  if (image.source.type === 'nutstore' && !image.source.privatePath) {
    materialized = await materializeNutstoreSource(job, image);
  }
  if (!materialized.source.privatePath) throw new Error('Image source is not available in private staging');

  const treatment = resolveImageTreatment(materialized);
  if (!treatment.allowAutomaticProcessing) {
    throw imageProcessingError(
      'ipc_manual_treatment_required',
      `${treatment.label} requires a verified manual treatment before fal.ai processing can continue.`,
    );
  }
  const sourceUrl = await createPrivateSourceUrl(materialized.source.privatePath, 900);
  const runId = randomUUID();
  const removed = await removeBackgroundWithFal(sourceUrl, providerOptions);
  const transparent = await downloadFalOutput(removed.outputUrl, providerOptions);
  const sourceBuffer = await downloadPrivateSource(materialized.source.privatePath);
  const preservation = await detectRemovedLightContent(sourceBuffer, transparent);
  const standardized = await standardizeFalOutput(transparent, { treatment });
  const transparentPrivatePath = await storeTransparentMaster(job, materialized, standardized.buffer, runId);
  const websiteReady = await createWebsiteReadyDerivative(standardized.buffer);
  const websiteReadyStorage = await uploadWebsiteReadyDerivative(job, materialized, websiteReady.buffer, runId);
  const measuredQuality = await analyzeImageQuality(websiteReady.buffer);
  const preservationWarning = preservation.suspicious
    ? ['possible_removed_label_or_light_product_part']
    : [];
  const quality = preservation.suspicious
    ? {
      ...measuredQuality,
      score: Math.min(74, measuredQuality.score),
      grade: 'needs_attention',
      requiresManualReview: true,
      flags: preservationWarning,
      preservation,
    }
    : { ...measuredQuality, preservation };

  const previousUsd = Number(image.cost?.usd) || 0;
  const previousZar = Number(image.cost?.zar) || 0;
  const latestZar = Number((FAL_BACKGROUND_COST_USD * FAL_USD_TO_ZAR).toFixed(2));
  return {
    ...materialized,
    status: 'review',
    reviewUrl: websiteReadyStorage.url,
    outputStoragePath: websiteReadyStorage.path,
    processed: {
      transparentPrivatePath,
      websiteReady: { ...websiteReadyStorage, ...websiteReady },
    },
    quality: { ...quality, provider: 'fal.ai' },
    warnings: [...new Set([...(image.warnings || []), ...standardized.warnings, ...preservationWarning])],
    cost: {
      usd: Number((previousUsd + FAL_BACKGROUND_COST_USD).toFixed(4)),
      zar: Number((previousZar + latestZar).toFixed(2)),
      latestUsd: FAL_BACKGROUND_COST_USD,
      latestZar,
      source: 'fal_pay_per_image',
      model: FAL_BACKGROUND_MODEL,
    },
    processing: {
      ...(image.processing || {}),
      provider: 'fal.ai',
      model: FAL_BACKGROUND_MODEL,
      requestId: removed.requestId,
      runId,
      treatment,
      finishedAt: new Date().toISOString(),
    },
    error: null,
  };
}

export function targetedRepairAssetId(job, image) {
  const identity = [job?.id, image?.id, image?.processing?.runId, image?.revision?.number, image?.outputStoragePath]
    .map((value) => String(value || ''))
    .join('\u0000');
  return `ipc_asset_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

/**
 * Explicit red-box background repair. It derives a same-size mask from the
 * exact private review asset, invokes the inpainting provider only for this
 * action, and returns a separate review revision. It never archives, applies,
 * updates Product Manager, or mutates the parent image.
 */
export async function createTargetedRepairRevision(job, image, {
  actor,
  displayedAssetId,
  displayRect,
  selection,
  providerOptions = {},
  loadAsset = downloadPrivateSource,
  storeAsset = storePrivateSource,
  createAssetUrl = createPrivateSourceUrl,
  repairProvider = reconstructTargetedRegionWithFal,
  downloadRepairOutput = downloadFalOutput,
} = {}) {
  if (!['review', 'ready', 'completed'].includes(image.status)) {
    throw imageProcessingError('ipc_repair_review_only', 'Targeted repair is available only for an unapproved image awaiting review.');
  }
  if (!image.outputStoragePath) throw imageProcessingError('ipc_repair_asset_missing', 'The displayed processed image is no longer available.');
  const expectedAssetId = targetedRepairAssetId(job, image);
  if (!displayedAssetId || displayedAssetId !== expectedAssetId) {
    throw imageProcessingError('ipc_repair_stale_asset', 'The displayed image changed. Refresh before drawing the repair box again.');
  }

  const displayedBuffer = await loadAsset(image.outputStoragePath);
  const displayed = await Jimp.read(displayedBuffer);
  const geometry = validateTargetedRepairMask({
    assetId: expectedAssetId,
    assetWidth: displayed.bitmap.width,
    assetHeight: displayed.bitmap.height,
    displayRect,
    selection,
  });
  const mask = await createTargetedRepairMask(geometry);
  await validateTargetedRepairMaskImage(mask.buffer, geometry);

  const runId = randomUUID();
  const revisionId = `${image.id}-repair-${runId.slice(0, 8)}`;
  const maskPath = await storeAsset({
    jobId: job.id,
    imageId: `${revisionId}-mask`,
    filename: `${revisionId}-mask.png`,
    contentType: 'image/png',
    buffer: mask.buffer,
  });
  const [imageUrl, maskUrl] = await Promise.all([
    createAssetUrl(image.outputStoragePath, 900),
    createAssetUrl(maskPath, 900),
  ]);
  const repaired = await repairProvider(imageUrl, maskUrl, geometry, {
    ...providerOptions,
    currentAssetId: expectedAssetId,
  });
  const repairedBuffer = await downloadRepairOutput(repaired.outputUrl, providerOptions);
  const repairedImage = await Jimp.read(repairedBuffer);
  if (repairedImage.bitmap.width !== displayed.bitmap.width || repairedImage.bitmap.height !== displayed.bitmap.height) {
    throw imageProcessingError('ipc_repair_geometry_changed', 'The repair provider changed the image geometry, so the result was rejected.');
  }
  // Even if the provider returns changes outside the requested mask, discard
  // them. Only pixels inside the confirmed red box may enter the revision.
  const repairedComposite = displayed.clone();
  const repairPatch = repairedImage.clone().crop({
    x: geometry.pixels.x,
    y: geometry.pixels.y,
    w: geometry.pixels.width,
    h: geometry.pixels.height,
  });
  repairedComposite.composite(repairPatch, geometry.pixels.x, geometry.pixels.y);
  const repairedMasterPath = await storeAsset({
    jobId: job.id,
    imageId: `${revisionId}-repair-master`,
    filename: `${revisionId}-repair-master.png`,
    contentType: 'image/png',
    buffer: await repairedComposite.getBuffer('image/png'),
  });
  const websiteReady = await createWebsiteReadyDerivative(await repairedComposite.getBuffer('image/png'), { size: displayed.bitmap.width });
  const outputStoragePath = await storeAsset({
    jobId: job.id,
    imageId: `${revisionId}-website-ready`,
    filename: `${revisionId}-1600-white.jpg`,
    contentType: 'image/jpeg',
    buffer: websiteReady.buffer,
  });
  const quality = await analyzeImageQuality(websiteReady.buffer);
  const now = new Date().toISOString();
  return {
    ...image,
    id: revisionId,
    status: 'review',
    reviewUrl: null,
    outputStoragePath,
    processed: {
      ...(image.processed || {}),
      transparentPrivatePath: repairedMasterPath,
      websiteReady: { path: outputStoragePath, url: null, ...websiteReady },
    },
    archive: null,
    approvedAt: null,
    approvedBy: null,
    quality,
    warnings: [...new Set([
      ...(image.warnings || []),
      'targeted_background_repair_requires_full_visual_review',
      'manual_labels_text_quantity_and_parts_review_required',
    ])],
    cost: {
      ...(image.cost || {}),
      latestUsd: null,
      latestZar: null,
      source: 'fal_pay_per_image_cost_unconfirmed',
      model: FAL_TARGETED_REPAIR_MODEL,
    },
    processing: {
      provider: 'fal.ai',
      model: FAL_TARGETED_REPAIR_MODEL,
      requestId: repaired.requestId,
      runId,
      treatment: resolveImageTreatment({ treatment: 'targeted_reconstruction', repair: geometry }),
      finishedAt: now,
    },
    createdAt: now,
    revision: {
      rootImageId: image.revision?.rootImageId || image.id,
      parentImageId: image.id,
      number: Math.max(1, Number(image.revision?.number) || 1) + 1,
      createdAt: now,
      createdBy: actor,
      action: 'targeted_repair',
      audit: {
        displayedAssetId: expectedAssetId,
        coordinateSpace: geometry.coordinateSpace,
        normalizedSelection: geometry.normalized,
        pixelSelection: geometry.pixels,
        maskPath,
        providerRequestId: repaired.requestId || null,
        preservedParent: true,
        liveMutation: false,
      },
    },
    error: null,
  };
}

const CLEARABLE_IMAGE_STATUSES = new Set(['review', 'ready', 'completed', 'approved', 'failed', 'error', 'rejected']);

function safeStagingSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function isStockStagingOutputOwnedBy(job, image, path) {
  const recordedPath = String(image?.processing?.outputPath || '');
  const candidate = String(path || '');
  const jobId = safeStagingSegment(job?.id);
  const imageId = safeStagingSegment(image?.id);
  const runId = safeStagingSegment(image?.processing?.runId);
  if (!recordedPath || candidate !== recordedPath || !jobId || !imageId || !runId) return false;
  const match = candidate.match(/^staging\/image-processing\/outputs\/([^/]+)\/([^/]+)\.([a-z0-9]+)$/i);
  if (!match || !['jpg', 'jpeg', 'png', 'webp'].includes(match[3].toLowerCase())) return false;
  return match[1] === jobId && match[2] === `${imageId}-${runId}`;
}

export async function removeExactWorkerStagingOutput(bucket, job, image, path) {
  if (!isStockStagingOutputOwnedBy(job, image, path)) {
    throw imageProcessingError('ipc_staging_cleanup_invalid', 'Worker staging cleanup was blocked because the object identity did not match this exact job run.');
  }
  const { error } = await bucket.remove([path]);
  if (error) {
    throw imageProcessingError(
      'ipc_staging_cleanup_failed',
      `The private review assets were retained, but the public worker staging object could not be removed: ${error.message}`,
    );
  }
}

export async function clearUnpublishedImage(job, image) {
  if (!CLEARABLE_IMAGE_STATUSES.has(image.status)) {
    throw new Error('Only an unarchived image awaiting review, approved, rejected, or failed can be cleared');
  }
  if (image.publishedUrl || image.publishedAt || image.archive?.assetId) {
    throw new Error('Archived or published images cannot be cleared from this queue');
  }

  const outputPaths = [...new Set([
    image.processing?.outputPath,
  ].filter((path) => isStockStagingOutputOwnedBy(job, image, path)))];
  if (outputPaths.length) {
    const stock = getStockClient();
    const { error } = await stock.storage.from(PRODUCT_BUCKET).remove(outputPaths);
    if (error) throw new Error(`Could not remove staged output: ${error.message}`);
  }

  await removePrivateImageArtifacts(job, image);
  const remainingImages = job.images.filter((row) => row.id !== image.id);
  if (!remainingImages.length) {
    await removeImageJobRecord(job.id);
    return null;
  }
  return persistJob({ ...job, images: remainingImages });
}

async function objectExists(bucket, path) {
  const parts = path.split('/');
  const name = parts.pop();
  const { data, error } = await bucket.list(parts.join('/'), { search: name, limit: 5 });
  return !error && (data || []).some((row) => row.name === name);
}

function imageProcessingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertProductionImageMutation(deploymentEnv = process.env.VERCEL_ENV) {
  if (String(deploymentEnv || '').trim().toLowerCase() !== 'production') {
    throw imageProcessingError(
      'ipc_production_only',
      'Preview and local environments are physically blocked from changing Product Manager images.',
    );
  }
}

export function assertCompletedCleanQuality(image) {
  const quality = image?.quality;
  const score = Number(quality?.score);
  const grade = String(quality?.grade || '').toLowerCase();
  if (!quality || !Number.isFinite(score) || !grade) {
    throw imageProcessingError(
      'ipc_quality_incomplete',
      'Automated quality assessment must complete before this image can be approved or applied.',
    );
  }
  const qualityFlags = [...new Set(quality.flags || [])];
  const hardQualityFlags = qualityFlags.filter((flag) => !ACKNOWLEDGEABLE_REVIEW_WARNINGS.has(String(flag).trim().toLowerCase()));
  if (quality.requiresManualReview || (!['excellent', 'good'].includes(grade) && hardQualityFlags.length > 0) || score < 75 || hardQualityFlags.length > 0) {
    throw imageProcessingError(
      'ipc_quality_blocked',
      'This image is not clean enough to approve. Resolve every quality warning and reprocess it first.',
    );
  }
  return quality;
}

const ACKNOWLEDGEABLE_REVIEW_WARNINGS = new Set([
  'transparent_edges_and_print_must_be_visually_verified',
  'fine_details_labels_and_holes_must_be_visually_verified',
  'piece_count_and_arrangement_must_be_visually_verified',
  'verified_measurements_require_manual_overlay',
  'custom_instructions_require_manual_review',
  'possible_detached_label_or_barcode',
  'manual_label_barcode_review_required',
  'targeted_background_repair_requires_full_visual_review',
  'manual_labels_text_quantity_and_parts_review_required',
]);

function completedReviewChecklist(checklist = {}) {
  return checklist.correctSku === true
    && checklist.labelsPreserved === true
    && checklist.cleanEdgesBackground === true;
}

function imageSlotForField(field) {
  const slot = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'].indexOf(field) + 1;
  return slot || null;
}

function resolvedProductDestination(image, requestedSlot = image.slot) {
  const slot = normalizeImageSlot(requestedSlot);
  if (!slot) {
    throw imageProcessingError('ipc_invalid_destination', 'Choose a valid Product Manager image position.');
  }
  const stored = image.destination;
  const manuallyAssigned = stored?.source === 'manual_selection';
  const destination = productManagerDestination({
    sku: manuallyAssigned ? stored.sku : image.sku,
    slot,
    targetTable: manuallyAssigned ? stored.table : image.targetTable,
  });
  if (!destination.sku || !destination.field || !ALLOWED_TARGET_TABLES.includes(destination.table)) {
    throw imageProcessingError(
      'ipc_invalid_destination',
      'This image does not have a valid Product Manager destination. Upload it again using the exact product SKU.',
    );
  }

  // Jobs created before the explicit destination contract do not have this
  // field, so derive it for backward compatibility. If a stored destination
  // is present, it must still point to the same Product Manager product.
  if (stored && !manuallyAssigned && (
    String(stored.system || '').toLowerCase() !== 'product_manager'
    || String(stored.table || '').toLowerCase() !== destination.table
    || String(stored.sku || '').toUpperCase() !== destination.sku
  )) {
    throw imageProcessingError(
      'ipc_destination_conflict',
      'This imageâ€™s saved Product Manager destination no longer matches its SKU. It was not sent anywhere.',
    );
  }
  return destination;
}

async function readExactProduct(stock, destination) {
  const { data, error } = await stock
    .from(destination.table)
    .select(`sku,title,${destination.field}`)
    .eq('sku', destination.sku)
    .limit(2);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) {
    throw imageProcessingError(
      'ipc_product_not_found',
      `No exact Product Manager product matches SKU ${destination.sku}. Nothing was changed.`,
    );
  }
  if (rows.length > 1) {
    throw imageProcessingError(
      'ipc_product_conflict',
      `Product Manager has more than one product with SKU ${destination.sku}. Resolve the duplicate before sending this image.`,
    );
  }
  return rows[0];
}

function assertNoJobDestinationConflict(job, image, destination) {
  const revisionRoot = (candidate) => candidate.revision?.rootImageId || candidate.id;
  const imageRoot = revisionRoot(image);
  const conflict = (job.images || []).find((candidate) => {
    if (candidate.id === image.id || ['rejected', 'failed', 'restored'].includes(candidate.status)) return false;
    // An adjusted archive revision deliberately targets the same SKU/slot as
    // its immutable parent. Live-image snapshot checks still prevent an older
    // member of the family from overwriting a newer applied revision.
    if (revisionRoot(candidate) === imageRoot) return false;
    const manuallyAssigned = candidate.destination?.source === 'manual_selection';
    const candidateSlot = candidate.publication?.slot || (manuallyAssigned ? candidate.destination?.slot : candidate.slot);
    const candidateDestination = productManagerDestination({
      sku: candidate.publication?.sku || (manuallyAssigned ? candidate.destination?.sku : candidate.sku),
      slot: candidateSlot,
      targetTable: candidate.publication?.table || (manuallyAssigned ? candidate.destination?.table : candidate.targetTable),
    });
    return candidateDestination.table === destination.table
      && candidateDestination.sku === destination.sku
      && candidateDestination.field === destination.field;
  });
  if (conflict) {
    throw imageProcessingError(
      'ipc_job_destination_conflict',
      `This batch already contains ${conflict.source?.filename || 'another image'} for ${destination.label} of SKU ${destination.sku}.`,
    );
  }
}

function conditionalImageUpdate(stock, destination, expectedUrl, nextUrl) {
  let query = stock
    .from(destination.table)
    .update({ [destination.field]: nextUrl, updated_at: new Date().toISOString() })
    .eq('sku', destination.sku);
  query = expectedUrl == null
    ? query.is(destination.field, null)
    : query.eq(destination.field, expectedUrl);
  return query.select('sku');
}

async function writeRequiredImageAudit(stock, {
  sku,
  action,
  source,
  publishMode,
  imageSlot,
  imageSource,
  oldValues,
  newValues,
  publishedBy,
}) {
  const { error } = await stock.from('product_publish_audit').insert({
    sku: String(sku || '').trim().toUpperCase(),
    action: action === 'create' ? 'create' : 'update',
    source: String(source || 'image_processing_centre'),
    publish_mode: String(publishMode || 'controlled_image_mutation'),
    image_slot: imageSlot != null ? Number(imageSlot) : null,
    image_source: imageSource ? String(imageSource) : null,
    category_confidence: null,
    old_values: oldValues || null,
    new_values: newValues || {},
    published_by: publishedBy ? String(publishedBy) : null,
    published_at: new Date().toISOString(),
  });
  if (error) {
    throw imageProcessingError(
      'ipc_audit_unavailable',
      `The required image audit trail could not be written. Product Manager was not changed: ${error.message}`,
    );
  }
}

export function markImageApproved(image, { actor, reviewChecklist = {} }) {
  if (image.status === 'approved' || image.status === 'archived' || image.status === 'published') return image;
  if (image.status !== 'review') throw new Error('Only an image awaiting review can be approved');
  assertCompletedCleanQuality(image);
  if (!completedReviewChecklist(reviewChecklist)) {
    throw imageProcessingError(
      'ipc_review_incomplete',
      'Confirm the exact SKU, preserved labels, and clean edges/background before approval.',
    );
  }
  const warnings = [...new Set(image.warnings || [])];
  const hardWarnings = warnings.filter((warning) => !ACKNOWLEDGEABLE_REVIEW_WARNINGS.has(warning));
  if (hardWarnings.length) {
    throw imageProcessingError(
      'ipc_quality_blocked',
      'This image still has unresolved processing warnings and must be reprocessed before approval.',
    );
  }
  if (warnings.length && reviewChecklist.treatmentVerified !== true) {
    throw imageProcessingError(
      'ipc_treatment_review_incomplete',
      'Complete the treatment-specific visual verification before approval.',
    );
  }
  return {
    ...image,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: actor,
    reviewChecklist: {
      correctSku: true,
      labelsPreserved: true,
      cleanEdgesBackground: true,
      treatmentVerified: warnings.length ? true : reviewChecklist.treatmentVerified === true,
      completedAt: new Date().toISOString(),
      completedBy: actor,
      acknowledgedWarnings: warnings,
    },
    error: null,
  };
}

export async function archiveApprovedImage(job, image, { actor, stockClient = null } = {}) {
  if (image.status === 'archived' && image.archive?.destinationSnapshot) return image;
  if (image.status !== 'approved') {
    if (image.status !== 'archived') throw new Error('Only an explicitly approved image can be saved to the Image Archive');
  }
  assertCompletedCleanQuality(image);
  if (!completedReviewChecklist(image.reviewChecklist)) {
    throw imageProcessingError('ipc_review_incomplete', 'The completed human review checklist is required before archiving.');
  }
  if (!image.processed?.transparentPrivatePath) {
    throw new Error('Approved image has no private transparent master to archive');
  }
  const sourcePath = image.outputStoragePath;
  if (!sourcePath?.startsWith('image-processing/sources/')) {
    throw new Error('Approved image does not have a website-ready 1600px white derivative');
  }

  // The approved derivative is already a private immutable object.  The
  // archive records that object rather than duplicating it into the public
  // product-images bucket.
  const archivePath = sourcePath;
  const destination = resolvedProductDestination(image);
  const stock = stockClient || getStockClient();
  let product = null;
  let destinationLookupUnavailable = false;
  try {
    product = await readExactProduct(stock, destination);
  } catch (error) {
    // Archiving is private and must remain available when the Product Manager
    // lookup is temporarily unavailable. Applying later still re-checks the
    // exact product and current live image before any mutation.
    if (error?.code !== 'ipc_product_not_found') throw error;
    destinationLookupUnavailable = true;
  }
  const destinationSnapshot = {
    ...destination,
    expectedLiveUrl: product?.[destination.field] || null,
    capturedAt: new Date().toISOString(),
    lookupUnavailable: destinationLookupUnavailable,
  };
  const parent = image.revision?.parentImageId
    ? (job.images || []).find((candidate) => candidate.id === image.revision.parentImageId)
    : null;
  return {
    ...image,
    status: 'archived',
    archivedAt: new Date().toISOString(),
    archivedBy: actor,
    archive: {
      assetId: `asset_${job.id}_${image.id}`,
      originalPrivatePath: image.source?.privatePath || null,
      transparentPrivatePath: image.processed.transparentPrivatePath,
      // Private variants intentionally have no durable public URL.  The API
      // mints short-lived review URLs when an owner opens the archive.
      originalUrl: null,
      transparentMasterUrl: null,
      websiteReadyPath: archivePath,
      websiteReadyUrl: null,
      destinationSnapshot,
      supersedesAssetId: parent?.archive?.assetId || null,
      specification: { width: 1600, height: 1600, background: '#FFFFFF', format: 'jpeg' },
    },
    error: null,
  };
}

// A filename normally supplies the destination SKU.  When an image comes from
// a camera or supplier folder with an opaque name, the owner may deliberately
// bind it to one verified Product Manager SKU.  This only stages the target;
// publishing still requires approval and a second explicit confirmation.
export async function assignImageDestination(image, {
  actor,
  sku,
  slot = image.slot,
  stockClient = null,
} = {}) {
  if (!['review', 'approved', 'archived'].includes(image.status)) {
    throw imageProcessingError('ipc_destination_assignment_not_allowed', 'Choose a Product Manager destination only after processing is ready for review, approved, or archived.');
  }
  const destination = productManagerDestination({
    sku: normalizeImageSku(sku),
    slot,
  });
  if (!destination.sku || !destination.field || !ALLOWED_TARGET_TABLES.includes(destination.table)) {
    throw imageProcessingError('ipc_invalid_destination', 'Choose a valid exact Product Manager product and image position.');
  }
  const stock = stockClient || getStockClient();
  await readExactProduct(stock, destination);
  return {
    ...image,
    destination: {
      ...destination,
      source: 'manual_selection',
      assignedAt: new Date().toISOString(),
      assignedBy: actor,
    },
    error: null,
  };
}

export async function applyArchivedImage(job, image, {
  actor,
  slot = image.slot,
  allowOverwrite = false,
  stockClient = null,
  confirmArchiveAssetId = null,
  deploymentEnv = process.env.VERCEL_ENV,
  loadArchivedSource = downloadPrivateSource,
  auditWriter = writeRequiredImageAudit,
}) {
  assertProductionImageMutation(deploymentEnv);
  if (image.status === 'published') return image;
  if (image.status !== 'archived') throw new Error('Only an explicitly archived image can be applied to Product Manager');
  assertCompletedCleanQuality(image);
  if (!completedReviewChecklist(image.reviewChecklist)) {
    throw imageProcessingError('ipc_review_incomplete', 'The completed human review checklist is required before applying this archive asset.');
  }
  if (!image.archive?.assetId || confirmArchiveAssetId !== image.archive.assetId) {
    throw imageProcessingError('ipc_archive_confirmation_required', 'Confirm the exact archived asset before applying it to Product Manager.');
  }
  const destination = resolvedProductDestination(image, slot);
  if (destination.slot !== image.slot && !allowOverwrite) {
    throw imageProcessingError(
      'ipc_destination_confirmation_required',
      `Confirm sending this image to ${destination.label}; it differs from the position detected from the filename.`,
    );
  }
  assertNoJobDestinationConflict(job, image, destination);
  const stock = stockClient || getStockClient();
  const product = await readExactProduct(stock, destination);
  const previousUrl = product[destination.field] || null;
  const snapshot = image.archive?.destinationSnapshot;
  if (!snapshot
    || snapshot.table !== destination.table
    || snapshot.sku !== destination.sku
    || snapshot.field !== destination.field) {
    throw imageProcessingError(
      'ipc_archive_snapshot_required',
      'This archive asset does not have a verified Product Manager snapshot. Save it to the archive again before applying.',
    );
  }
  if ((snapshot.expectedLiveUrl || null) !== previousUrl) {
    throw imageProcessingError(
      'ipc_product_image_conflict',
      `Product Manager changed ${destination.label} for SKU ${destination.sku} after this asset was archived. Refresh and review the latest image before trying again.`,
    );
  }
  if (previousUrl && !allowOverwrite) {
    throw imageProcessingError(
      'image_exists',
      `${destination.label} for SKU ${destination.sku} already has an image. Review it and explicitly confirm replacement.`,
    );
  }

  const sourcePath = image.archive?.websiteReadyPath;
  if (!sourcePath?.startsWith('image-processing/sources/')) throw new Error('Archived website-ready image is not available');
  const safeJob = job.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16);
  const safeImage = image.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16);
  const outputExtension = sourcePath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const livePath = `${destination.sku}/${destination.slot}-${safeJob}-${safeImage}.${outputExtension}`;
  const bucket = stock.storage.from(PRODUCT_BUCKET);
  const operationId = `ipc_${job.id}_${image.id}_${randomUUID()}`;
  await auditWriter(stock, {
    sku: destination.sku,
    action: 'update',
    source: 'image_processing_centre',
    publishMode: 'archived_asset_apply_authorized',
    imageSlot: destination.slot,
    imageSource: image.source.type,
    oldValues: { [destination.field]: previousUrl },
    newValues: { outcome: 'apply_authorized', jobId: job.id, imageId: image.id, operationId },
    publishedBy: actor,
  });
  const archivedBuffer = await loadArchivedSource(sourcePath);
  const { error: copyError } = await bucket.upload(livePath, archivedBuffer, {
    contentType: 'image/jpeg', cacheControl: 'max-age=31536000, immutable', upsert: false,
  });
  if (copyError && !(await objectExists(bucket, livePath))) throw new Error(`Could not stage the Product Manager image: ${copyError.message}`);
  const liveUrl = bucket.getPublicUrl(livePath).data.publicUrl;

  const { data: updatedRows, error: updateError } = await conditionalImageUpdate(
    stock,
    destination,
    previousUrl,
    liveUrl,
  );
  if (updateError) throw updateError;
  if (!updatedRows?.length) {
    throw imageProcessingError(
      'ipc_product_image_conflict',
      `Product Manager changed ${destination.label} for SKU ${destination.sku} while this result was being sent. Refresh and review the latest image before trying again.`,
    );
  }

  await logProductLoaderAudit(stock, {
    sku: destination.sku,
    action: 'update',
    source: 'image_processing_centre',
    publishMode: 'archived_asset_apply',
    imageSlot: destination.slot,
    imageSource: image.source.type,
    oldValues: { [destination.field]: previousUrl },
    newValues: { outcome: 'approved', [destination.field]: liveUrl, jobId: job.id, imageId: image.id, operationId, quality: image.quality },
    publishedBy: actor,
  });

  return {
    ...image,
    status: 'published',
    slot: destination.slot,
    targetTable: destination.table,
    destination,
    publishedUrl: liveUrl,
    publishedAt: new Date().toISOString(),
    publishedBy: actor,
    publication: {
      ...destination,
      previousUrl,
      originalUrl: previousUrl,
      liveUrl,
      livePath,
    },
    error: null,
  };
}

// Compatibility guard: a stale client cannot convert an approved review into
// a live product-image change. Future clients must use archive then apply.
export async function publishApprovedImage() {
  throw imageProcessingError(
    'archive_required',
    'Direct publishing is disabled. Save the approved result to the Image Archive, then explicitly apply the archived asset.',
  );
}

export async function restorePublishedOriginal(job, image, {
  actor,
  stockClient = null,
  deploymentEnv = process.env.VERCEL_ENV,
  auditWriter = writeRequiredImageAudit,
}) {
  assertProductionImageMutation(deploymentEnv);
  if (image.status === 'restored') return image;
  if (image.status !== 'published' || !image.publication?.field) {
    throw new Error('Only a published processed image can be restored');
  }
  const publicationSlot = normalizeImageSlot(image.publication.slot)
    || imageSlotForField(image.publication.field);
  const destination = productManagerDestination({
    sku: image.publication.sku || image.sku,
    slot: publicationSlot,
    targetTable: image.publication.table || image.targetTable,
  });
  if (!destination.field || destination.field !== image.publication.field || !ALLOWED_TARGET_TABLES.includes(destination.table)) {
    throw imageProcessingError('ipc_restore_destination_invalid', 'The saved Product Manager destination is invalid; the original was not changed.');
  }
  const stock = stockClient || getStockClient();
  const product = await readExactProduct(stock, destination);
  const liveUrl = image.publication.liveUrl || image.publishedUrl || null;
  if (!liveUrl || product[destination.field] !== liveUrl) {
    throw imageProcessingError(
      'ipc_restore_conflict',
      `Restore stopped because ${destination.label} for SKU ${destination.sku} has changed since this result was sent. It will not overwrite a newer Product Manager image.`,
    );
  }
  const previousUrl = image.publication.originalUrl ?? image.publication.previousUrl ?? null;
  const operationId = `ipc_restore_${job.id}_${image.id}_${randomUUID()}`;
  await auditWriter(stock, {
    sku: destination.sku,
    action: 'update',
    source: 'image_processing_centre',
    publishMode: 'restore_original_authorized',
    imageSlot: destination.slot,
    imageSource: image.source.type,
    oldValues: { [destination.field]: liveUrl },
    newValues: { outcome: 'restore_authorized', [destination.field]: previousUrl, jobId: job.id, imageId: image.id, operationId },
    publishedBy: actor,
  });
  const { data: restoredRows, error } = await conditionalImageUpdate(stock, destination, liveUrl, previousUrl);
  if (error) throw error;
  if (!restoredRows?.length) {
    throw imageProcessingError(
      'ipc_restore_conflict',
      `Restore stopped because Product Manager changed ${destination.label} for SKU ${destination.sku}. Refresh and review the current image.`,
    );
  }

  await logProductLoaderAudit(stock, {
    sku: destination.sku,
    action: 'update',
    source: 'image_processing_centre',
    publishMode: 'restore_original',
    imageSlot: destination.slot,
    imageSource: image.source.type,
    oldValues: { [destination.field]: liveUrl },
    newValues: { outcome: 'restored_original', [destination.field]: previousUrl, jobId: job.id, imageId: image.id, operationId },
    publishedBy: actor,
  });

  return {
    ...image,
    status: 'restored',
    restoredAt: new Date().toISOString(),
    restoredBy: actor,
    restoredUrl: previousUrl,
    error: null,
  };
}

export async function rejectImage(image, { actor, reason = '' } = {}) {
  if (image.status === 'approved') throw new Error('An approved image cannot be rejected');
  if (image.status === 'rejected') return image;
  return {
    ...image,
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectedBy: actor,
    rejectionReason: String(reason || '').trim().slice(0, 500) || null,
  };
}

