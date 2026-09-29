// Match the filename-based backend contract. MIME alone is not sufficient:
// browsers report SVG/HEIC/GIF as images, but the loader cannot import them.
export const INTAKE_IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp';
const SUPPORTED = /\.(jpe?g|png|webp)$/i;
const OTHER_IMAGE = /\.(svg|gif|heic|heif|avif|bmp|tiff?|ico)$/i;

export function inspectIntakeImageSelection(fileList) {
  const files = Array.from(fileList || []);
  const accepted = files.filter((file) => SUPPORTED.test(file.name || ''));
  const rejected = files.filter((file) => !SUPPORTED.test(file.name || '')
    && (file.type?.startsWith('image/') || OTHER_IMAGE.test(file.name || '')));
  const names = rejected.slice(0, 3).map((file) => file.name).join(', ');
  const message = rejected.length
    ? `Unsupported image format: ${names}${rejected.length > 3 ? ` and ${rejected.length - 3} more` : ''}. Convert to JPG, PNG or WebP and choose the converted files. ${accepted.length ? 'Supported images will still be checked.' : 'Your current batch has not been changed.'}`
    : accepted.length ? '' : 'No supported images found. Choose JPG, PNG or WebP files. Your current batch has not been changed.';
  return { accepted, rejected, message };
}
