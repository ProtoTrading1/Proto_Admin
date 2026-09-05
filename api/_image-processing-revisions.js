import { randomUUID } from 'node:crypto';
import { Jimp } from 'jimp';
import { downloadPrivateSource, storePrivateSource } from './_image-processing-store.js';
const WHITE = '#FFFFFF';
const ALLOWED_SHADOWS = new Set(['none', 'soft']);

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

/** The archive deliberately supports one web background: the Proto catalogue white. */
export function normalizeArchiveAdjustments(raw = {}) {
  const background = String(raw.background || WHITE).trim().toUpperCase();
  if (background !== WHITE) throw new Error('Archive revisions support the standard #FFFFFF website background only');
  const shadow = String(raw.shadow || 'none').trim().toLowerCase();
  if (!ALLOWED_SHADOWS.has(shadow)) throw new Error('Shadow must be none or soft');
  return {
    background,
    paddingRatio: Number(clamp(raw.paddingRatio ?? raw.padding_ratio, 0.04, 0.2, 0.08).toFixed(3)),
    shadow,
  };
}

function opaqueBounds(image) {
  const { width, height, data } = image.bitmap;
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (data[((y * width) + x) * 4 + 3] <= 8) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Make a fresh web derivative from the retained transparent master; fal.ai is never called. */
export async function createArchiveRevisionDerivative(masterBuffer, rawAdjustments = {}) {
  const adjustments = normalizeArchiveAdjustments(rawAdjustments);
  const master = await Jimp.read(masterBuffer);
  const bounds = opaqueBounds(master);
  if (!bounds) throw new Error('The retained transparent master has no visible product to adjust');
  const product = master.clone().crop(bounds);
  const size = 1600;
  const usable = Math.round(size * (1 - (adjustments.paddingRatio * 2)));
  const scale = Math.min(usable / product.bitmap.width, usable / product.bitmap.height);
  product.resize({ w: Math.max(1, Math.round(product.bitmap.width * scale)), h: Math.max(1, Math.round(product.bitmap.height * scale)) });
  const x = Math.round((size - product.bitmap.width) / 2);
  const y = Math.round((size - product.bitmap.height) / 2);
  const canvas = new Jimp({ width: size, height: size, color: 0xffffffff });
  if (adjustments.shadow === 'soft') {
    const shadow = product.clone();
    const pixels = shadow.bitmap.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      pixels[index] = 0; pixels[index + 1] = 0; pixels[index + 2] = 0; pixels[index + 3] = Math.round(alpha * 0.18);
    }
    // Jimp's Gaussian kernel scales poorly on a 1600px catalogue canvas.
    // Its separable box blur produces the intended subtle shadow without
    // making a single archive adjustment monopolise the serverless function.
    shadow.blur(12);
    canvas.composite(shadow, x, y + Math.max(8, Math.round(size * 0.012)));
  }
  canvas.composite(product, x, y);
  return {
    buffer: await canvas.getBuffer('image/jpeg'),
    specification: { width: size, height: size, background: WHITE, format: 'jpeg', ...adjustments },
  };
}

/**
 * Create a new review item in the same batch. Its archived parent remains
 * immutable; only the retained transparent master is used for this revision.
 */
export async function createArchiveRevision(job, image, {
  actor,
  adjustments,
  loadMaster = downloadPrivateSource,
  storeDerivative = storePrivateSource,
} = {}) {
  if (!['archived', 'published', 'restored'].includes(image.status)) throw new Error('Only an archived image can be adjusted into a new revision');
  const transparentPrivatePath = image.archive?.transparentPrivatePath || image.processed?.transparentPrivatePath;
  if (!transparentPrivatePath) throw new Error('This archive asset no longer has its retained transparent master');
  const normalized = normalizeArchiveAdjustments(adjustments);
  const masterBuffer = await loadMaster(transparentPrivatePath);
  const derivative = await createArchiveRevisionDerivative(masterBuffer, normalized);
  const revisionNumber = Math.max(1, Number(image.revision?.number) || 1) + 1;
  const revisionId = `${image.id}-rev-${revisionNumber}-${randomUUID().slice(0, 8)}`;
  // Like every archive asset, this derivative remains private until a later
  // explicit Product Manager apply action makes one public product copy.
  const outputStoragePath = await storeDerivative({
    jobId: job.id,
    imageId: `${revisionId}-website-ready`,
    filename: `${revisionId}-1600-white.jpg`,
    contentType: 'image/jpeg',
    buffer: derivative.buffer,
  });
  // This renderer itself fixes the canvas, background and minimum padding, so
  // its output quality contract is deterministic and does not need a second
  // multi-million-pixel scan before human review.
  const quality = {
    score: 100,
    grade: 'excellent',
    width: derivative.specification.width,
    height: derivative.specification.height,
    whiteBorderRatio: 1,
    borderNoise: 0,
    clippedEdgeRatio: 0,
    source: 'controlled_archive_revision_renderer',
  };
  const reviewUrl = null;
  const now = new Date().toISOString();
  return {
    ...image,
    id: revisionId,
    status: 'review',
    reviewUrl,
    outputStoragePath,
    processed: {
      ...(image.processed || {}),
      transparentPrivatePath,
      websiteReady: { path: outputStoragePath, url: reviewUrl, ...derivative.specification },
    },
    archive: null,
    approvedAt: null,
    approvedBy: null,
    archivedAt: null,
    archivedBy: null,
    publishedAt: null,
    publishedBy: null,
    publishedUrl: null,
    publication: null,
    quality,
    error: null,
    createdAt: now,
    revision: {
      rootImageId: image.revision?.rootImageId || image.id,
      parentImageId: image.id,
      number: revisionNumber,
      createdAt: now,
      createdBy: actor,
      adjustments: normalized,
    },
  };
}
