import { createHash } from 'node:crypto';

export const IMAGE_JOB_LIMITS = Object.freeze({
  maxImages: 50,
  maxUploadBytesPerImage: 10 * 1024 * 1024,
  maxUploadBytesPerJob: 24 * 1024 * 1024,
  maxInstructionsLength: 1_000,
});

export const IMAGE_FIELDS = Object.freeze([
  'image_url_one',
  'image_url_two',
  'image_url_three',
  'image_url_four',
]);

export const IMAGE_STATUSES = Object.freeze([
  'queued',
  'processing',
  'review',
  'approved',
  'archived',
  'published',
  'restored',
  'rejected',
  'failed',
]);

// Image Processing Centre only sends approved results to the live catalogue
// managed in Product Manager. Keeping this allowlist to one table makes the
// destination a real contract rather than an arbitrary client-supplied table.
export const PRODUCT_MANAGER_TABLE = 'website_stock';
export const ALLOWED_TARGET_TABLES = Object.freeze([PRODUCT_MANAGER_TABLE]);
export const ALLOWED_SOURCE_TYPES = Object.freeze(['nutstore', 'local_upload', 'staged_url']);
export const IMAGE_TREATMENTS = Object.freeze([
  'standard_opaque',
  'transparent_clear',
  'beads_fine_detail',
  'multi_piece',
  'shadow',
  'measurements',
  'custom',
  'targeted_reconstruction',
]);

export const PRODUCT_MANAGER_IMAGE_POSITIONS = Object.freeze([
  'Main product image',
  'Gallery image 2',
  'Gallery image 3',
  'Gallery image 4',
]);

function cleanText(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeTreatmentName(value, instructions = '') {
  const name = cleanText(value || 'standard', 60).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    standard: 'standard_opaque', opaque: 'standard_opaque', generative: 'custom',
    transparent: 'transparent_clear', clear: 'transparent_clear', clear_packaging: 'transparent_clear',
    beads: 'beads_fine_detail', fine_detail: 'beads_fine_detail', multi: 'multi_piece',
    measurement: 'measurements', targeted: 'targeted_reconstruction', reconstruction: 'targeted_reconstruction',
  };
  const normalized = aliases[name] || name;
  if (IMAGE_TREATMENTS.includes(normalized)) return normalized;
  return cleanText(instructions, IMAGE_JOB_LIMITS.maxInstructionsLength) ? 'custom' : 'standard_opaque';
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRepairMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const display = value.displayRect || {};
  const selection = value.selection || {};
  return {
    assetId: cleanText(value.assetId, 240),
    assetWidth: finiteNumber(value.assetWidth),
    assetHeight: finiteNumber(value.assetHeight),
    displayRect: {
      x: finiteNumber(display.x, 0), y: finiteNumber(display.y, 0),
      width: finiteNumber(display.width), height: finiteNumber(display.height),
    },
    selection: {
      x: finiteNumber(selection.x), y: finiteNumber(selection.y),
      width: finiteNumber(selection.width), height: finiteNumber(selection.height),
    },
  };
}

export function normalizeImageSku(value) {
  return cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

export function normalizeImageSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) return null;
  return slot;
}

export function imageFieldForSlot(slot) {
  const cleanSlot = normalizeImageSlot(slot);
  return cleanSlot ? IMAGE_FIELDS[cleanSlot - 1] : null;
}

/**
 * The only place an Image Processing Centre result may be sent.  This is
 * stored with the job as well as derived at publish time, so a review always
 * has a named Product Manager destination instead of an unexplained "slot".
 */
export function productManagerDestination({ sku, slot, targetTable = PRODUCT_MANAGER_TABLE } = {}) {
  const cleanSku = normalizeImageSku(sku);
  const cleanSlot = normalizeImageSlot(slot);
  const table = cleanText(targetTable || PRODUCT_MANAGER_TABLE, 40).toLowerCase();
  const field = imageFieldForSlot(cleanSlot);
  return {
    system: 'product_manager',
    table,
    sku: cleanSku,
    slot: cleanSlot,
    field,
    label: cleanSlot ? PRODUCT_MANAGER_IMAGE_POSITIONS[cleanSlot - 1] : '',
  };
}

export function decodeBase64Bytes(base64) {
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) return 0;
  return Math.floor((raw.length * 3) / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0);
}

export function stableImageId({ sku, slot, sourceType, sourceRef, filename }) {
  const digest = createHash('sha256')
    .update([sku, slot, sourceType, sourceRef, filename].map((v) => String(v || '')).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `img_${digest}`;
}

export function stableJobId(idempotencyKey, fingerprint) {
  const digest = createHash('sha256')
    .update(`${cleanText(idempotencyKey, 200)}\u0000${fingerprint}`)
    .digest('hex')
    .slice(0, 24);
  return `ipc_${digest}`;
}

export function normalizeCreateImage(raw = {}) {
  const sku = normalizeImageSku(raw.sku || raw.code);
  const slot = normalizeImageSlot(raw.slot || raw.imageSlot || 1);
  const sourceType = cleanText(raw.source?.type || raw.sourceType, 40).toLowerCase();
  const targetTable = cleanText(raw.targetTable || PRODUCT_MANAGER_TABLE, 40).toLowerCase();
  const filename = cleanText(raw.source?.filename || raw.filename || `${sku || 'image'}.jpg`, 180);
  const contentType = cleanText(raw.source?.contentType || raw.contentType || 'image/jpeg', 80).toLowerCase();
  const sourceRef = cleanText(
    raw.source?.path || raw.nutstorePath || raw.source?.url || raw.sourceUrl,
    2_000,
  );
  const base64 = String(raw.source?.base64 || raw.base64 || '').replace(/^data:[^;]+;base64,/, '');

  const errors = [];
  if (!sku) errors.push('sku is required');
  if (!slot) errors.push('slot must be 1, 2, 3, or 4');
  if (!ALLOWED_SOURCE_TYPES.includes(sourceType)) errors.push('source type is not supported');
  if (!ALLOWED_TARGET_TABLES.includes(targetTable)) errors.push('target table is not supported');
  if (sourceType === 'nutstore' && !sourceRef) errors.push('Nutstore path is required');
  if (sourceType === 'staged_url' && !sourceRef) errors.push('staged source URL is required');
  if (sourceType === 'local_upload' && !base64) errors.push('local upload base64 is required');
  if (base64 && !/^image\/(jpeg|jpg|png|webp)$/i.test(contentType)) errors.push('unsupported image content type');

  const uploadBytes = base64 ? decodeBase64Bytes(base64) : 0;
  if (base64 && !uploadBytes) errors.push('local upload is not valid base64');
  if (uploadBytes > IMAGE_JOB_LIMITS.maxUploadBytesPerImage) errors.push('local upload exceeds 10 MB');

  const style = cleanText(raw.style || raw.imageStyle || 'standard', 40).toLowerCase();
  const instructions = cleanText(raw.instructions || raw.userInstructions, IMAGE_JOB_LIMITS.maxInstructionsLength);
  const treatment = normalizeTreatmentName(raw.treatment || style, instructions);
  const sourceFingerprint = base64
    ? createHash('sha256').update(base64).digest('hex')
    : sourceRef;
  const id = stableImageId({ sku, slot, sourceType, sourceRef: sourceFingerprint, filename });

  return {
    ok: errors.length === 0,
    errors,
    uploadBytes,
    base64,
    image: {
      id,
      sku,
      slot,
      targetTable,
      destination: productManagerDestination({ sku, slot, targetTable }),
      overwrite: raw.overwrite === true || raw.overwriteImage === true,
      source: { type: sourceType, ref: sourceRef, filename, contentType },
      style: ['standard', 'shadow', 'generative', 'measurements'].includes(style) ? style : 'standard',
      treatment,
      manualSafeCutout: raw.manualSafeCutout === true,
      repair: normalizeRepairMetadata(raw.repair || raw.targetedRepair),
      instructions,
      productTitle: cleanText(raw.productTitle || raw.title, 300),
      productDescription: cleanText(raw.productDescription || raw.description, 2_000),
    },
  };
}

export function jobFingerprint(images) {
  return createHash('sha256')
    .update(JSON.stringify(images.map((image) => ({
      id: image.id,
      sku: image.sku,
      slot: image.slot,
      targetTable: image.targetTable,
      overwrite: image.overwrite,
      source: image.source,
      style: image.style,
      treatment: image.treatment,
      manualSafeCutout: image.manualSafeCutout,
      repair: image.repair,
      instructions: image.instructions,
    }))))
    .digest('hex');
}

export function deriveJobStatus(images = []) {
  const statuses = images.map((image) => image.status);
  if (!statuses.length) return 'empty';
  if (statuses.includes('processing')) return 'processing';
  if (statuses.includes('queued')) return statuses.some((s) => s !== 'queued') ? 'partially_processed' : 'queued';
  if (statuses.includes('review')) return 'review';
  if (statuses.includes('failed')) return 'partially_failed';
  if (statuses.every((s) => ['approved', 'archived', 'published', 'restored'].includes(s))) return 'complete';
  if (statuses.every((s) => s === 'rejected')) return 'rejected';
  return 'closed';
}

export function summarizeJob(images = []) {
  const counts = Object.fromEntries(IMAGE_STATUSES.map((status) => [status, 0]));
  let costUsd = 0;
  let costZar = 0;
  for (const image of images) {
    if (counts[image.status] != null) counts[image.status] += 1;
    costUsd += Number(image.cost?.usd) || 0;
    costZar += Number(image.cost?.zar) || 0;
  }
  return {
    total: images.length,
    ...counts,
    costUsd: Number(costUsd.toFixed(6)),
    costZar: Number(costZar.toFixed(4)),
  };
}

export function qualityScoreFromMetrics({
  width = 0,
  height = 0,
  whiteBorderRatio = 0,
  borderNoise = 1,
  clippedEdgeRatio = 1,
} = {}) {
  const resolution = Math.min(1, Math.min(Number(width) || 0, Number(height) || 0) / 800);
  const background = Math.max(0, Math.min(1, Number(whiteBorderRatio) || 0));
  const cleanliness = 1 - Math.max(0, Math.min(1, Number(borderNoise) || 0));
  const framing = 1 - Math.max(0, Math.min(1, Number(clippedEdgeRatio) || 0));
  const score = Math.round(100 * ((resolution * 0.2) + (background * 0.35) + (cleanliness * 0.3) + (framing * 0.15)));
  return {
    score,
    grade: score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'needs_attention',
  };
}

export function sanitizeJobForResponse(job) {
  if (!job) return null;
  return {
    ...job,
    images: (job.images || []).map((image) => ({
      ...image,
      source: { ...image.source, ref: image.source?.type === 'nutstore' ? image.source.ref : undefined },
    })),
  };
}
