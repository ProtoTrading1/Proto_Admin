import { hasAdminKey, requireOwner, verifyAdminUser } from './_admin-auth.js';
import {
  claimImageObject,
  createPrivateSourceUrl,
  readImageJob,
  readImageJobIndex,
  releaseImageObjectClaim,
} from './_image-processing-store.js';
import {
  ingestLocalSource,
  ingestStagedSource,
  estimatedImageCostUsd,
  clearUnpublishedImage,
  createTargetedRepairRevision,
  applyArchivedImage,
  assignImageDestination,
  archiveApprovedImage,
  markImageApproved,
  persistJob,
  processImageWithFal,
  rejectImage,
  restorePublishedOriginal,
  targetedRepairAssetId,
} from './_image-processing-service.js';
import { createArchiveRevision } from './_image-processing-revisions.js';
import { parseImageProcessingRequest } from './_image-processing-request.js';
import { parseLoaderFilename } from './_product-loader-filename.js';
import { parseNutstoreFilename } from './_nutstore-filename.js';
import {
  IMAGE_JOB_LIMITS,
  jobFingerprint,
  normalizeCreateImage,
  productManagerDestination,
  stableJobId,
} from '../lib/image-processing-centre.mjs';

export const config = { api: { bodyParser: false } };

const FAL_CLAIM_TTL_SECONDS = 900;
const FAL_START_CLAIM_JOB = 'fal-processing-starts';
const FAL_RUN_CLAIM_JOB = 'fal-processing-runs';
const LEGACY_FAL_RECOVERY_DELAY_MS = 6 * 60_000;

function falClaimScope(jobId, imageId) {
  return `${jobId}-${imageId}`;
}

async function requestActor(req) {
  if (hasAdminKey(req)) return 'server-admin';
  const user = await verifyAdminUser(req);
  return String(user?.email || 'owner').toLowerCase();
}

function splitPublicId(value) {
  const raw = String(value || '').trim();
  const marker = raw.indexOf('~');
  return marker > 0
    ? { jobId: raw.slice(0, marker), imageId: raw.slice(marker + 1) }
    : { jobId: raw, imageId: '' };
}

function publicImageJob(job, image) {
  const destination = image.publication?.field
    ? {
      ...productManagerDestination({
        sku: image.publication.sku || image.sku,
        slot: image.publication.slot || image.slot,
        targetTable: image.publication.table || image.targetTable,
      }),
      field: image.publication.field,
    }
    : image.destination || productManagerDestination(image);
  const warnings = [...new Set([
    ...(image.warnings || []),
    ...(image.quality?.grade === 'needs_attention' ? ['quality_needs_attention'] : []),
  ])];
  return {
    id: `${job.id}~${image.id}`,
    manifestId: job.id,
    imageId: image.id,
    filename: image.source?.filename,
    sku: image.sku,
    source: image.source?.type === 'local_upload' ? 'upload' : image.source?.type,
    source_path: image.source?.type === 'nutstore' ? image.source.ref : '',
    status: image.status,
    after_url: image.publishedUrl || image.reviewUrl || '',
    processed_url: image.reviewUrl || '',
    quality_score: image.quality?.score ?? null,
    quality_flags: warnings,
    cost_usd: Number(image.cost?.usd) || 0,
    cost_zar: Number(image.cost?.zar) || 0,
    estimated_cost_zar: Number(image.cost?.zar) || Number(((Number(image.estimatedCostUsd) || 0) * 18).toFixed(2)),
    target_slot: destination.slot,
    target_field: destination.field,
    destination,
    archive: image.archive || null,
    website_ready: image.processed?.websiteReady || null,
    displayed_asset_id: image.outputStoragePath ? targetedRepairAssetId(job, image) : null,
    restored_url: image.restoredUrl || '',
    error: image.error || '',
    created_at: image.createdAt || job.createdAt,
    updated_at: job.updatedAt,
  };
}

function falProcessorContract(job, image) {
  return {
    endpoint: `/api/image-processing-jobs?id=${encodeURIComponent(`${job.id}~${image.id}`)}`,
    method: 'PATCH',
    body: { action: 'execute' },
  };
}

async function startFalProcessing(res, actor, job, index) {
  const image = job.images[index];
  if (image.status === 'processing') {
    if (image.processing?.provider !== 'fal.ai' || !image.processing?.claimId) {
      return res.status(409).json({
        error: 'A previous processing attempt has an unknown outcome. Wait for it to finish or use Retry after it is marked failed.',
      });
    }
    return res.status(202).json({
      ok: true,
      accepted: true,
      idempotent: true,
      job: publicImageJob(job, image),
      processor: falProcessorContract(job, image),
    });
  }
  if (image.status !== 'queued') {
    return res.status(409).json({ error: 'Only a queued image can start processing' });
  }

  const scope = falClaimScope(job.id, image.id);
  const claim = await claimImageObject(FAL_START_CLAIM_JOB, scope, {
    workerId: `fal:${actor}`,
    ttlSeconds: FAL_CLAIM_TTL_SECONDS,
  });
  if (!claim) {
    const current = await readImageJob(job.id);
    const currentImage = current?.images?.find((row) => row.id === image.id);
    if (currentImage?.status === 'processing' && currentImage.processing?.claimId) {
      return res.status(202).json({
        ok: true,
        accepted: true,
        idempotent: true,
        job: publicImageJob(current, currentImage),
        processor: falProcessorContract(current, currentImage),
      });
    }
    return res.status(202).json({
      ok: true,
      accepted: true,
      idempotent: true,
      pending: true,
      job: publicImageJob(job, image),
    });
  }

  try {
    const current = await readImageJob(job.id);
    const currentIndex = current?.images?.findIndex((row) => row.id === image.id) ?? -1;
    if (!current || currentIndex < 0) throw new Error('Image processing item disappeared while it was being claimed');
    const currentImage = current.images[currentIndex];
    if (currentImage.status !== 'queued') {
      await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, claim.id).catch(() => {});
      if (currentImage.status === 'processing' && currentImage.processing?.claimId) {
        return res.status(202).json({
          ok: true,
          accepted: true,
          idempotent: true,
          job: publicImageJob(current, currentImage),
          processor: falProcessorContract(current, currentImage),
        });
      }
      return res.status(409).json({ error: 'Only a queued image can start processing' });
    }

    current.images[currentIndex] = {
      ...currentImage,
      status: 'processing',
      processing: {
        provider: 'fal.ai',
        state: 'awaiting_dispatch',
        claimId: claim.id,
        claimedBy: `fal:${actor}`,
        startedAt: new Date().toISOString(),
        expiresAt: claim.expiresAt,
      },
      error: null,
    };
    const saved = await persistJob(current);
    const savedImage = saved.images[currentIndex];
    return res.status(202).json({
      ok: true,
      accepted: true,
      idempotent: false,
      job: publicImageJob(saved, savedImage),
      processor: falProcessorContract(saved, savedImage),
    });
  } catch (error) {
    await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, claim.id).catch(() => {});
    throw error;
  }
}

async function runFalProcessing(res, actor, job, index) {
  let image = job.images[index];
  if (image.status === 'review') {
    const [publicReview] = await publicJobItemsWithSource(job, [image]);
    return res.status(200).json({ ok: true, idempotent: true, job: publicReview });
  }

  // Preview builds before the asynchronous contract saved `processing`
  // without a durable claim, then performed fal.ai work inside the browser's
  // 15-second request. If that request was interrupted the manifest can remain
  // stuck forever. Adopt only an attempt older than the previous function's
  // five-minute maximum, so recovery cannot overlap the original paid call.
  if (image.status === 'processing' && image.processing?.provider === 'fal.ai' && !image.processing?.claimId) {
    const startedAt = new Date(image.processing?.startedAt || 0).getTime();
    const safelyStale = Number.isFinite(startedAt)
      && startedAt > 0
      && (Date.now() - startedAt) >= LEGACY_FAL_RECOVERY_DELAY_MS;
    if (!safelyStale) {
      return res.status(202).json({
        ok: true,
        accepted: true,
        idempotent: true,
        alreadyRunning: true,
        job: publicImageJob(job, image),
      });
    }

    const scope = falClaimScope(job.id, image.id);
    const recoveryClaim = await claimImageObject(FAL_START_CLAIM_JOB, scope, {
      workerId: `fal-recovery:${actor}`,
      ttlSeconds: FAL_CLAIM_TTL_SECONDS,
    });
    if (!recoveryClaim) {
      const current = await readImageJob(job.id);
      const currentImage = current?.images?.find((row) => row.id === image.id);
      return res.status(202).json({
        ok: true,
        accepted: true,
        idempotent: true,
        alreadyRunning: true,
        job: publicImageJob(current || job, currentImage || image),
      });
    }

    const current = await readImageJob(job.id);
    const currentIndex = current?.images?.findIndex((row) => row.id === image.id) ?? -1;
    const currentImage = currentIndex >= 0 ? current.images[currentIndex] : null;
    if (!current || !currentImage) {
      await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, recoveryClaim.id).catch(() => {});
      throw new Error('Image processing item disappeared during recovery');
    }
    if (currentImage.status === 'review') {
      await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, recoveryClaim.id).catch(() => {});
      const [publicReview] = await publicJobItemsWithSource(current, [currentImage]);
      return res.status(200).json({ ok: true, idempotent: true, job: publicReview });
    }
    if (currentImage.status !== 'processing' || currentImage.processing?.claimId) {
      await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, recoveryClaim.id).catch(() => {});
      return res.status(202).json({
        ok: true,
        accepted: true,
        idempotent: true,
        alreadyRunning: true,
        job: publicImageJob(current, currentImage),
      });
    }

    current.images[currentIndex] = {
      ...currentImage,
      processing: {
        ...currentImage.processing,
        state: 'awaiting_dispatch',
        claimId: recoveryClaim.id,
        claimedBy: `fal-recovery:${actor}`,
        recoveredAt: new Date().toISOString(),
        expiresAt: recoveryClaim.expiresAt,
      },
      error: null,
    };
    job = await persistJob(current);
    index = currentIndex;
    image = job.images[index];
  }

  if (image.status !== 'processing' || image.processing?.provider !== 'fal.ai' || !image.processing?.claimId) {
    return res.status(409).json({ error: 'This image does not have an active fal.ai processing claim' });
  }

  const scope = falClaimScope(job.id, image.id);
  const runClaim = await claimImageObject(FAL_RUN_CLAIM_JOB, scope, {
    workerId: `fal-run:${actor}`,
    ttlSeconds: FAL_CLAIM_TTL_SECONDS,
  });
  if (!runClaim) {
    return res.status(202).json({
      ok: true,
      accepted: true,
      idempotent: true,
      alreadyRunning: true,
      job: publicImageJob(job, image),
    });
  }

  let terminalPersisted = false;
  let runningJob;
  let runningIndex;
  try {
    runningJob = await readImageJob(job.id);
    runningIndex = runningJob?.images?.findIndex((row) => row.id === image.id) ?? -1;
    if (!runningJob || runningIndex < 0) throw new Error('Image processing item disappeared before dispatch');
    const currentImage = runningJob.images[runningIndex];

    if (currentImage.status === 'review') {
      terminalPersisted = true;
      const [publicReview] = await publicJobItemsWithSource(runningJob, [currentImage]);
      return res.status(200).json({ ok: true, idempotent: true, job: publicReview });
    }
    if (currentImage.status !== 'processing' || currentImage.processing?.claimId !== image.processing.claimId) {
      return res.status(409).json({ error: 'The fal.ai processing claim is stale' });
    }
    if (currentImage.processing?.dispatchedAt) {
      runningJob.images[runningIndex] = {
        ...currentImage,
        status: 'failed',
        error: 'The previous fal.ai request has an unknown outcome and was not repeated to avoid a duplicate charge.',
        processing: {
          ...currentImage.processing,
          state: 'outcome_unknown',
          failedAt: new Date().toISOString(),
        },
      };
      const failed = await persistJob(runningJob);
      terminalPersisted = true;
      return res.status(409).json({
        error: failed.images[runningIndex].error,
        job: publicImageJob(failed, failed.images[runningIndex]),
      });
    }

    runningJob.images[runningIndex] = {
      ...currentImage,
      processing: {
        ...currentImage.processing,
        state: 'dispatched',
        dispatchClaimId: runClaim.id,
        dispatchedAt: new Date().toISOString(),
      },
    };
    runningJob = await persistJob(runningJob);

    try {
      runningJob.images[runningIndex] = await processImageWithFal(runningJob, runningJob.images[runningIndex]);
    } catch (error) {
      runningJob.images[runningIndex] = {
        ...runningJob.images[runningIndex],
        status: 'failed',
        error: error.message || 'fal.ai processing failed',
        processing: {
          ...(runningJob.images[runningIndex].processing || {}),
          state: 'failed',
          failedAt: new Date().toISOString(),
        },
      };
      const failed = await persistJob(runningJob);
      terminalPersisted = true;
      return res.status(502).json({
        error: failed.images[runningIndex].error,
        job: publicImageJob(failed, failed.images[runningIndex]),
      });
    }

    const saved = await persistJob(runningJob);
    terminalPersisted = true;
    const [publicUpdated] = await publicJobItemsWithSource(saved, [saved.images[runningIndex]]);
    return res.status(200).json({ ok: true, job: publicUpdated });
  } finally {
    if (terminalPersisted) {
      await releaseImageObjectClaim(FAL_RUN_CLAIM_JOB, scope, runClaim.id).catch(() => {});
      await releaseImageObjectClaim(FAL_START_CLAIM_JOB, scope, image.processing.claimId).catch(() => {});
    }
  }
}

async function publicJobItemsWithSource(job, images = job?.images || []) {
  return Promise.all(images.map(async (image) => {
    const row = publicImageJob(job, image);
    if (!image.source?.privatePath) return row;
    try {
      row.before_url = await createPrivateSourceUrl(image.source.privatePath, 600);
      row.original_url = row.before_url;
    } catch { /* preview remains unavailable until the next refresh */ }
    const reviewPath = image.archive?.websiteReadyPath || image.outputStoragePath || image.processed?.websiteReady?.path;
    if (String(reviewPath || '').startsWith('image-processing/sources/')) {
      try {
        const reviewUrl = await createPrivateSourceUrl(reviewPath, 600);
        row.after_url = image.publishedUrl || reviewUrl;
        row.processed_url = reviewUrl;
        if (row.website_ready) row.website_ready = { ...row.website_ready, url: reviewUrl };
        if (row.archive) row.archive = { ...row.archive, websiteReadyUrl: reviewUrl };
      } catch { /* a later owner refresh will mint a fresh review URL */ }
    }
    return row;
  }));
}

function adaptIncomingItem(item, batchSource) {
  if (item?.source?.type || item?.sourceType) return item;
  const source = String(batchSource || '').toLowerCase();
  const filename = String(item?.filename || item?.name || item?.path || '').replace(/\\/g, '/');
  const basename = filename.split('/').pop() || filename;
  if (source === 'nutstore') {
    const parsed = parseNutstoreFilename(basename);
    return {
      ...item,
      sku: item.sku || item.code || parsed.code,
      slot: item.slot || parsed.imageSlot,
      source: { type: 'nutstore', path: item.path, filename: basename, contentType: item.contentType || 'image/jpeg' },
    };
  }
  if (source === 'upload' || source === 'local_upload') {
    const parsed = parseLoaderFilename(basename);
    return {
      ...item,
      sku: item.sku || item.code || parsed.code,
      slot: item.slot || parsed.imageSlot,
      source: {
        type: 'local_upload',
        filename,
        contentType: item.contentType,
        base64: item.base64,
      },
    };
  }
  return item;
}

async function createJob(req, res, actor) {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items[] is required' });
  if (items.length > IMAGE_JOB_LIMITS.maxImages) {
    return res.status(400).json({ error: `A job may contain at most ${IMAGE_JOB_LIMITS.maxImages} images` });
  }

  const normalized = items.map((item) => normalizeCreateImage(adaptIncomingItem(item, req.body?.source)));
  const invalid = normalized
    .map((result, index) => ({ index, errors: result.errors }))
    .filter((result) => result.errors.length);
  if (invalid.length) return res.status(400).json({ error: 'One or more images are invalid', invalid });

  const uploadBytes = normalized.reduce((sum, result) => sum + result.uploadBytes, 0);
  if (uploadBytes > IMAGE_JOB_LIMITS.maxUploadBytesPerJob) {
    return res.status(413).json({ error: 'Combined local uploads exceed 24 MB' });
  }

  const images = normalized.map((result) => result.image);
  const targetKeys = images.map((image) => `${image.targetTable}:${image.sku}:${image.slot}`);
  if (new Set(targetKeys).size !== targetKeys.length) {
    return res.status(409).json({ error: 'A job cannot contain the same product image slot more than once' });
  }

  const fingerprint = jobFingerprint(images);
  const idempotencyKey = String(
    req.headers['idempotency-key'] || req.body?.idempotencyKey || fingerprint,
  ).trim().slice(0, 200);
  const id = stableJobId(idempotencyKey, fingerprint);
  const existing = await readImageJob(id);
  if (existing) return res.status(200).json({ ok: true, idempotent: true, jobs: await publicJobItemsWithSource(existing) });

  const estimatedCostUsd = images.reduce((sum, image) => sum + estimatedImageCostUsd(image), 0);
  const maxCostUsd = 0;

  const createdAt = new Date().toISOString();
  const prepared = [];
  for (let index = 0; index < images.length; index += 1) {
    let image = { ...images[index], status: 'queued', createdAt, error: null };
    if (image.source.type === 'local_upload') {
      image = await ingestLocalSource(id, image, normalized[index].base64);
    } else if (image.source.type === 'staged_url') {
      image = await ingestStagedSource(id, image);
    }
    image.estimatedCostUsd = estimatedImageCostUsd(image);
    prepared.push(image);
  }

  const sourceTypes = new Set(prepared.map((image) => image.source.type));
  const job = await persistJob({
    id,
    version: 0,
    status: 'queued',
    sourceFlow: sourceTypes.size === 1 ? [...sourceTypes][0] : 'mixed',
    createdAt,
    createdBy: actor,
    idempotencyKeyHash: id.slice(4),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    maxCostUsd,
    images: prepared,
  });
  return res.status(201).json({ ok: true, idempotent: false, jobs: await publicJobItemsWithSource(job) });
}

async function reviewAction(req, res, actor, action) {
  const publicId = splitPublicId(req.query?.id || req.body?.id);
  const imageId = String(req.body?.imageId || publicId.imageId).trim();
  const job = await readImageJob(publicId.jobId);
  if (!job) return res.status(404).json({ error: 'Image processing job not found' });
  const index = job.images.findIndex((image) => image.id === imageId);
  if (index < 0) return res.status(404).json({ error: 'Image processing item not found' });

  try {
    if (action === 'process') {
      return await startFalProcessing(res, actor, job, index);
    } else if (action === 'execute') {
      return await runFalProcessing(res, actor, job, index);
    } else if (action === 'approve') {
      job.images[index] = markImageApproved(job.images[index], {
        actor,
        reviewChecklist: req.body?.reviewChecklist,
      });
    } else if (action === 'assign_destination') {
      job.images[index] = await assignImageDestination(job.images[index], {
        actor,
        sku: req.body?.destinationSku,
        slot: req.body?.imageSlot ?? job.images[index].slot,
      });
    } else if (action === 'archive') {
      job.images[index] = await archiveApprovedImage(job, job.images[index], { actor });
    } else if (action === 'create_revision') {
      const revision = await createArchiveRevision(job, job.images[index], {
        actor,
        adjustments: req.body?.adjustments,
      });
      // Do not overwrite the archive asset: each adjustment is a separately
      // reviewable staged revision derived from the retained master.
      job.images.push(revision);
      const saved = await persistJob(job);
      const [publicRevision] = await publicJobItemsWithSource(saved, [revision]);
      return res.status(201).json({ ok: true, job: publicRevision });
    } else if (action === 'targeted_repair') {
      const revision = await createTargetedRepairRevision(job, job.images[index], {
        actor,
        displayedAssetId: req.body?.displayedAssetId,
        displayRect: req.body?.displayRect,
        selection: req.body?.selection,
      });
      job.images.push(revision);
      const saved = await persistJob(job);
      const [publicRevision] = await publicJobItemsWithSource(saved, [revision]);
      return res.status(201).json({ ok: true, parentId: `${job.id}~${imageId}`, job: publicRevision });
    } else if (action === 'apply') {
      if (req.body?.confirmArchiveAssetId !== job.images[index].archive?.assetId) {
        return res.status(409).json({ error: 'Confirm the exact archived asset before applying it to Product Manager.' });
      }
      const hasRequestedSlot = Object.prototype.hasOwnProperty.call(req.body || {}, 'imageSlot');
      job.images[index] = await applyArchivedImage(job, job.images[index], {
        actor,
        slot: hasRequestedSlot ? req.body.imageSlot : job.images[index].slot,
        allowOverwrite: req.body?.publishToExistingSlot === true,
        confirmArchiveAssetId: req.body?.confirmArchiveAssetId,
      });
    } else if (action === 'reject') {
      job.images[index] = await rejectImage(job.images[index], { actor, reason: req.body?.reason });
    } else if (action === 'restore') {
      job.images[index] = await restorePublishedOriginal(job, job.images[index], { actor });
    } else if (action === 'retry') {
      if (!['failed', 'rejected', 'review'].includes(job.images[index].status)) {
        return res.status(409).json({ error: 'Only failed, rejected, or review images can be reprocessed' });
      }
      job.images[index] = {
        ...job.images[index],
        status: 'queued',
        reviewUrl: null,
        outputStoragePath: null,
        quality: null,
        error: null,
        processing: null,
      };
    } else if (action === 'clear') {
      const saved = await clearUnpublishedImage(job, job.images[index]);
      return res.status(200).json({
        ok: true,
        removed: `${job.id}~${imageId}`,
        jobs: saved ? await publicJobItemsWithSource(saved) : [],
      });
    }
    const saved = await persistJob(job);
    const [publicUpdated] = await publicJobItemsWithSource(saved, [saved.images[index]]);
    return res.status(200).json({ ok: true, job: publicUpdated });
  } catch (error) {
    const status = ['image_exists', 'ipc_destination_conflict', 'ipc_job_destination_conflict', 'ipc_product_conflict', 'ipc_product_image_conflict', 'ipc_restore_conflict', 'ipc_archive_confirmation_required', 'ipc_archive_snapshot_required', 'ipc_repair_stale_asset', 'ipc_repair_geometry_changed'].includes(error.code)
      ? 409
      : error.code === 'ipc_production_only'
        ? 403
      : error.code === 'ipc_product_not_found'
        ? 404
        : 400;
    return res.status(status).json({ error: error.message || `${action} failed` });
  }
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requestActor(req);

  try {
    if (req.method === 'GET') {
      const publicId = splitPublicId(req.query?.id);
      if (publicId.jobId) {
        const job = await readImageJob(publicId.jobId);
        if (!job) return res.status(404).json({ error: 'Image processing job not found' });
        const images = publicId.imageId
          ? job.images.filter((image) => image.id === publicId.imageId)
          : job.images;
        return res.status(200).json({ jobs: await publicJobItemsWithSource(job, images) });
      }
      const rows = await readImageJobIndex();
      const manifests = await Promise.all(rows.slice(0, 100).map((row) => readImageJob(row.id)));
      const jobRows = await Promise.all(manifests.filter(Boolean).map((job) => publicJobItemsWithSource(job)));
      return res.status(200).json({ jobs: jobRows.flat() });
    }
    if (!['POST', 'PATCH'].includes(req.method)) return res.status(405).end();

    req.body = await parseImageProcessingRequest(req);

    const requestedAction = String(req.body?.action || 'create').trim().toLowerCase();
    // `apply_archived` appeared in an earlier client contract. Keep it as a
    // compatibility alias, but route it through the same guarded `apply`
    // branch so it cannot quietly return a successful no-op.
    const action = requestedAction === 'apply_archived' ? 'apply' : requestedAction;
    if (action === 'create') return await createJob(req, res, actor);
    if (['process', 'execute', 'approve', 'assign_destination', 'archive', 'create_revision', 'apply', 'targeted_repair', 'reject', 'retry', 'restore', 'clear'].includes(action)) return await reviewAction(req, res, actor, action);
    return res.status(400).json({ error: 'Unsupported image processing action' });
  } catch (error) {
    console.error('image-processing-jobs:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Image processing request failed' });
  }
}

