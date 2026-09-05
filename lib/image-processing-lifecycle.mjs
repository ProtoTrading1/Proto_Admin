export const IMAGE_TREATMENTS = Object.freeze({
  standard: 'standard',
  transparent: 'transparent',
  fineDetail: 'fine_detail',
});

export const JOB_STATUSES = Object.freeze({
  queued: 'queued',
  processing: 'processing',
  readyForReview: 'ready_for_review',
  approved: 'approved',
  applying: 'applying',
  applied: 'applied',
  discarded: 'discarded',
  needsAttention: 'needs_attention',
  expired: 'expired',
});

const BEAD_OR_FINE_DETAIL = /\b(beads?|seed\s*beads?|rhinestones?|sequins?|findings?|jewell?ery|charms?|tiny\s+(?:parts?|pieces?|items?)|loose\s+(?:parts?|pieces?))\b/i;
const TRANSPARENT_OR_CLEAR = /\b(transparent|clear|translucent|acrylic|perspex|plastic|pvc|\bpet\b|glass|crystal|bubble|ball)\b/i;
const MULTI_PIECE = /\b(multi[-\s]?piece|set|pack|bundle|assorted|\d+\s*(?:pc|pcs|pieces))\b/i;

function contextText(input = {}) {
  return [
    input.productTitle,
    input.category,
    input.subcategoryOne,
    input.subcategoryTwo,
    input.filename,
  ].filter(Boolean).join(' ');
}

/**
 * Classify conservatively. Every result requires a human review. Clear
 * packaging and tiny/beaded products are deliberately manual-only: the
 * existing generative background-removal pipeline is not safe to use for
 * those shapes until it has been independently validated.
 */
export function classifyImageTreatment(input = {}) {
  const text = contextText(input);
  if (BEAD_OR_FINE_DETAIL.test(text)) {
    return {
      treatment: IMAGE_TREATMENTS.fineDetail,
      label: 'Fine-detail / beads review',
      reason: 'Small loose pieces or detailed beadwork need a preservation-first review.',
      imageStyle: null,
      manualOnly: true,
      requiresManualReview: true,
    };
  }
  if (TRANSPARENT_OR_CLEAR.test(text)) {
    return {
      treatment: IMAGE_TREATMENTS.transparent,
      label: 'Transparent packaging review',
      reason: 'Clear or reflective material needs transparent-product treatment and manual review.',
      imageStyle: null,
      manualOnly: true,
      requiresManualReview: true,
    };
  }
  if (MULTI_PIECE.test(text)) {
    return {
      treatment: IMAGE_TREATMENTS.standard,
      label: 'Standard cleanup — multi-piece product',
      reason: 'Keep every item in the set visible and review the composition before approval.',
      imageStyle: 'standard',
      manualOnly: false,
      requiresManualReview: true,
    };
  }
  return {
    treatment: IMAGE_TREATMENTS.standard,
    label: 'Standard cleanup — opaque product',
    reason: 'Standard cleanup is suitable, but a person must still review the result before it can be applied.',
    imageStyle: 'standard',
    manualOnly: false,
    requiresManualReview: true,
  };
}

export function treatmentPresentation(treatment) {
  const value = String(treatment || '').trim();
  if (value === IMAGE_TREATMENTS.fineDetail) {
    return {
      label: 'Fine-detail / beads review',
      manualOnly: true,
      imageStyle: null,
    };
  }
  if (value === IMAGE_TREATMENTS.transparent) {
    return {
      label: 'Transparent packaging review',
      manualOnly: true,
      imageStyle: null,
    };
  }
  return {
    label: 'Standard cleanup — manual review required',
    manualOnly: false,
    imageStyle: 'standard',
  };
}

export function slotField(slot = 1) {
  const fields = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
  const safeSlot = Math.min(4, Math.max(1, Number(slot) || 1));
  return fields[safeSlot - 1];
}

export function normalizeImageUrl(url) {
  const raw = String(url || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw.split('?')[0].split('#')[0].replace(/\/$/, '');
  }
}

export function canTransition(from, to) {
  const allowed = {
    [JOB_STATUSES.queued]: [JOB_STATUSES.processing, JOB_STATUSES.discarded],
    [JOB_STATUSES.needsAttention]: [JOB_STATUSES.processing, JOB_STATUSES.discarded],
    [JOB_STATUSES.processing]: [JOB_STATUSES.readyForReview, JOB_STATUSES.needsAttention],
    [JOB_STATUSES.readyForReview]: [JOB_STATUSES.approved, JOB_STATUSES.discarded],
    [JOB_STATUSES.approved]: [JOB_STATUSES.applying, JOB_STATUSES.discarded],
    [JOB_STATUSES.applying]: [JOB_STATUSES.applied, JOB_STATUSES.needsAttention],
  };
  return (allowed[from] || []).includes(to);
}

export function reviewChecklistComplete(checklist = {}) {
  return Boolean(
    checklist.correctProduct
    && checklist.labelsPreserved
    && checklist.backgroundClean,
  );
}

export function isProductionEnvironment(environment = '') {
  return String(environment || '').toLowerCase() === 'production';
}
