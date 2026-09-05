const DRAFT_KEY = 'proto-product-loader-upload-draft';

// File objects cannot be serialised. Keep them in module memory so an upload
// survives switching Product Loader tabs, and retain a small session record so
// a refresh can explain that the file must be selected again. This helper never
// publishes or uploads an image.
let memoryDraft = null;

function storage() {
  try { return window.sessionStorage; } catch { return null; }
}

export function saveProductLoaderUploadDraft(items) {
  if (!items?.length) return clearProductLoaderUploadDraft();
  memoryDraft = items;
  storage()?.setItem(DRAFT_KEY, JSON.stringify({
    count: items.length,
    filenames: items.map((item) => item.filename || item.file?.name).filter(Boolean),
  }));
}

export function getProductLoaderUploadDraft() {
  return memoryDraft;
}

export function getProductLoaderUploadDraftRecovery() {
  try {
    const raw = storage()?.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearProductLoaderUploadDraft() {
  memoryDraft = null;
  storage()?.removeItem(DRAFT_KEY);
}
