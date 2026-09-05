import { requireImageProcessor } from './_admin-auth.js';
import {
  claimImageObject,
  readImageJob,
  readImageJobIndex,
  releaseImageObjectClaim,
} from './_image-processing-store.js';
import {
  canClaimWithinCostLimit,
  completeWorkerOutput,
  persistJob,
  prepareWorkerClaim,
} from './_image-processing-service.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

function findImageIndex(job, imageId) {
  return job?.images?.findIndex((image) => image.id === imageId) ?? -1;
}

async function candidateJobs(requestedId) {
  if (requestedId) {
    const job = await readImageJob(requestedId);
    return job ? [job] : [];
  }
  const index = await readImageJobIndex();
  const queued = index.filter((row) => ['queued', 'partially_processed', 'partially_failed'].includes(row.status));
  const jobs = [];
  for (const row of queued.slice(0, 20)) {
    const job = await readImageJob(row.id);
    if (job) jobs.push(job);
  }
  return jobs;
}

async function claim(req, res) {
  const workerId = String(req.body?.workerId || 'processor').trim().slice(0, 80);
  const jobs = await candidateJobs(String(req.query?.id || req.body?.id || '').trim());

  for (const job of jobs) {
    const requestedImageId = String(req.body?.imageId || '').trim();
    const image = requestedImageId
      ? job.images.find((row) => row.id === requestedImageId && row.status === 'queued')
      : job.images.find((row) => row.status === 'queued');
    if (!image) continue;

    const cost = canClaimWithinCostLimit(job, image);
    if (!cost.allowed) continue;
    const claimScope = `${image.targetTable}-${image.sku}-${image.slot}`;
    const objectClaim = await claimImageObject('targets', claimScope, { workerId, ttlSeconds: 600 });
    if (!objectClaim) continue;

    try {
      const prepared = await prepareWorkerClaim(job, image, { expiresIn: 600 });
      const index = findImageIndex(job, image.id);
      job.images[index] = {
        ...prepared.image,
        status: 'processing',
        processing: {
          ...(prepared.image.processing || {}),
          ...(prepared.claimState || {}),
          claimId: objectClaim.id,
          workerId,
          startedAt: new Date().toISOString(),
          expiresAt: objectClaim.expiresAt,
        },
        error: null,
      };
      await persistJob(job);
      return res.status(200).json({ claimId: objectClaim.id, ...prepared.claimPayload });
    } catch (error) {
      await releaseImageObjectClaim('targets', claimScope, objectClaim.id);
      throw error;
    }
  }
  return res.status(204).end();
}

async function callback(req, res, failed = false) {
  const jobId = String(req.query?.id || req.body?.jobId || '').trim();
  const imageId = String(req.body?.imageId || '').trim();
  const claimId = String(req.body?.claimId || '').trim();
  const job = await readImageJob(jobId);
  if (!job) return res.status(404).json({ error: 'Image processing job not found' });
  const index = findImageIndex(job, imageId);
  if (index < 0) return res.status(404).json({ error: 'Image processing item not found' });
  const image = job.images[index];
  if (image.status === 'review' && !failed) return res.status(200).json({ ok: true, idempotent: true });
  if (image.processing?.claimId !== claimId || image.status !== 'processing') {
    return res.status(409).json({ error: 'Worker claim is stale or does not match this image' });
  }

  try {
    if (failed) {
      job.images[index] = {
        ...image,
        status: 'failed',
        error: String(req.body?.error || 'Worker processing failed').slice(0, 500),
        processing: { ...image.processing, finishedAt: new Date().toISOString() },
      };
    } else {
      job.images[index] = await completeWorkerOutput(job, image, req.body);
    }
    const saved = await persistJob(job);
    const claimScope = `${image.targetTable}-${image.sku}-${image.slot}`;
    await releaseImageObjectClaim('targets', claimScope, claimId);
    return res.status(200).json({ ok: true, image: saved.images[index] });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Worker callback failed' });
  }
}

export default async function handler(req, res) {
  if (!requireImageProcessor(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const jobs = await readImageJobIndex();
    const pending = jobs.filter((row) => ['queued', 'partially_processed', 'partially_failed'].includes(row.status));
    return res.status(200).json({ pending: pending.length, jobs: pending.slice(0, 20).map(({ id, status, summary }) => ({ id, status, summary })) });
  }
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const action = String(req.body?.action || 'claim').trim().toLowerCase();
    if (action === 'claim') return await claim(req, res);
    if (action === 'callback') return await callback(req, res, false);
    if (action === 'fail') return await callback(req, res, true);
    return res.status(400).json({ error: 'Unsupported worker action' });
  } catch (error) {
    console.error('image-processing-worker:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Image processor request failed' });
  }
}
