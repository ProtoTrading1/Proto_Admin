export const IMAGE_PROCESSING_HANDOFF_KEY = 'proto:image-processing:nutstore-handoff';
export const IMAGE_PROCESSING_HANDOFF_TTL_MS = 30 * 60_000;
export const IMAGE_PROCESSING_INTAKE_KEY = 'proto:image-processing:intake-options';

const DEFAULT_INTAKE_OPTIONS = Object.freeze({ treatment: 'standard_opaque', instructions: '' });
const ALLOWED_INTAKE_TREATMENTS = new Set([
  'standard_opaque', 'shadow', 'transparent_clear', 'beads_fine_detail',
  'multi_piece', 'measurements', 'custom',
]);

function cleanIntakeOptions(value) {
  const requestedTreatment = String(value?.treatment || DEFAULT_INTAKE_OPTIONS.treatment).trim().toLowerCase();
  const treatment = ALLOWED_INTAKE_TREATMENTS.has(requestedTreatment)
    ? requestedTreatment
    : DEFAULT_INTAKE_OPTIONS.treatment;
  return {
    treatment,
    instructions: String(value?.instructions || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000),
  };
}

function cleanSelection(selection) {
  if (!Array.isArray(selection)) return [];
  const seen = new Set();
  return selection
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      path: item.path.trim(),
      filename: String(item.filename || item.name || item.path.split('/').pop() || '').trim(),
      ...(item.sku ? { sku: String(item.sku).trim().toUpperCase() } : {}),
    }))
    .filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    })
    .slice(0, 200);
}

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadPendingNutstoreHandoff({ storage = browserStorage(), now = Date.now() } = {}) {
  if (!storage) return [];
  try {
    const payload = JSON.parse(storage.getItem(IMAGE_PROCESSING_HANDOFF_KEY) || 'null');
    if (payload?.version !== 1 || Number(payload.expiresAt) <= now) {
      storage.removeItem(IMAGE_PROCESSING_HANDOFF_KEY);
      return [];
    }
    return cleanSelection(payload.nutstoreSelection);
  } catch {
    try { storage.removeItem(IMAGE_PROCESSING_HANDOFF_KEY); } catch { /* storage unavailable */ }
    return [];
  }
}

export function savePendingNutstoreHandoff(selection, {
  storage = browserStorage(),
  now = Date.now(),
  ttlMs = IMAGE_PROCESSING_HANDOFF_TTL_MS,
} = {}) {
  const nutstoreSelection = cleanSelection(selection);
  if (!storage) return nutstoreSelection;
  try {
    if (!nutstoreSelection.length) {
      storage.removeItem(IMAGE_PROCESSING_HANDOFF_KEY);
    } else {
      storage.setItem(IMAGE_PROCESSING_HANDOFF_KEY, JSON.stringify({
        version: 1,
        createdAt: now,
        expiresAt: now + Math.max(60_000, Number(ttlMs) || IMAGE_PROCESSING_HANDOFF_TTL_MS),
        nutstoreSelection,
      }));
    }
  } catch { /* keep the in-memory handoff working when storage is unavailable */ }
  return nutstoreSelection;
}

export function clearPendingNutstoreHandoff({ storage = browserStorage() } = {}) {
  try { storage?.removeItem(IMAGE_PROCESSING_HANDOFF_KEY); } catch { /* storage unavailable */ }
}

export function loadImageProcessingIntake({ storage = browserStorage() } = {}) {
  if (!storage) return { ...DEFAULT_INTAKE_OPTIONS };
  try {
    return cleanIntakeOptions(JSON.parse(storage.getItem(IMAGE_PROCESSING_INTAKE_KEY) || 'null'));
  } catch {
    try { storage.removeItem(IMAGE_PROCESSING_INTAKE_KEY); } catch { /* storage unavailable */ }
    return { ...DEFAULT_INTAKE_OPTIONS };
  }
}

export function saveImageProcessingIntake(options, { storage = browserStorage() } = {}) {
  const clean = cleanIntakeOptions(options);
  try { storage?.setItem(IMAGE_PROCESSING_INTAKE_KEY, JSON.stringify(clean)); } catch { /* in-memory state still works */ }
  return clean;
}
