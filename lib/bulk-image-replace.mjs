/** Max products per bulk image replace run (client + server). */
export const BULK_IMAGE_REPLACE_MAX = 500;

/** Max items per replace API request (keeps body under Vercel limit). */
export const BULK_IMAGE_REPLACE_REQUEST_BATCH = 8;

/** Parallel storage uploads inside one API request. */
export const BULK_IMAGE_REPLACE_UPLOAD_CONCURRENCY = 4;

export const BULK_IMAGE_REPLACE_SLOT_COLS = [
  'image_url_one',
  'image_url_two',
  'image_url_three',
  'image_url_four',
];

/** Expected filename stem examples for UI copy. */
export function slotFilenameExample(sku, slot) {
  const s = String(sku || 'BASHEWS').trim().toUpperCase();
  if (slot === 1) return `${s}.jpg`;
  return `${s}.${slot}.jpg`;
}
