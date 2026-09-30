// Base64 adds ~1/3: keep inline uploads well below Vercel's request limit.
export const PRODUCT_IMAGE_MAX_BYTES = 1_500_000;
export const PRODUCT_IMAGE_MAX_EDGE = 1600;

export function imageCanvasDimensions(width, height, { size = 800, square = true } = {}) {
  const scale = Math.min(1, size / Math.max(width || 1, height || 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return {
    width: square ? size : w,
    height: square ? size : h,
    w, h,
    offsetX: square ? Math.round((size - w) / 2) : 0,
    offsetY: square ? Math.round((size - h) / 2) : 0,
  };
}

export async function prepareProductManagerImage(file, compress) {
  if (!file || !Number.isFinite(file.size) || file.size < 1) {
    throw new Error('The selected product image is empty');
  }
  // Preserve approved, already-optimized images byte-for-byte. The storefront
  // independently requests lightweight thumbnails from its image CDN.
  if (file.size <= PRODUCT_IMAGE_MAX_BYTES && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    return { file, contentType: file.type, filename: `${file.name.replace(/\.[^.]+$/, '')}.${ext}` };
  }
  const prepared = await compress(file, { size: PRODUCT_IMAGE_MAX_EDGE, square: false });
  if (!prepared || !Number.isFinite(prepared.size) || prepared.size < 1 || prepared.size > PRODUCT_IMAGE_MAX_BYTES) {
    throw new Error('This image is too large to upload safely. Save it below 1.5 MB and try again.');
  }
  return { file: prepared, contentType: 'image/jpeg', filename: `${file.name.replace(/\.[^.]+$/, '')}.jpg` };
}
