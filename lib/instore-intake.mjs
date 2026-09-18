const IMAGE_RE = /\.(?:jpe?g|png|webp)$/i;
const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

export const INSTORE_STATES = new Set(['archived', 'live', 'recycle']);
export const INSTORE_MODES = new Set(['positill', 'stock_available', 'to_order']);

export function cleanSku(value) {
  const sku = String(value ?? '').trim().toUpperCase();
  return SKU_RE.test(sku) ? sku : '';
}

export function parseInstoreFilename(filename) {
  const raw = String(filename ?? '').trim();
  if (!raw || !IMAGE_RE.test(raw)) return { sku: '', imageSlot: 1, error: 'unsupported_filename' };
  const stem = raw.slice(0, raw.lastIndexOf('.')).trim();
  const match = stem.match(/^(.*?)(?:\.([1-4]))?$/);
  const sku = cleanSku(match?.[1]);
  if (!sku) return { sku: '', imageSlot: 1, error: 'invalid_sku_filename' };
  return { sku, imageSlot: Number(match?.[2] || 1), error: null };
}

export function decodeImageBase64(value, contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0];
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(type)) {
    throw new Error('Only JPEG, PNG, and WebP images are accepted');
  }
  const raw = String(value || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('imageBase64 is invalid');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('Image must be between 1 byte and 2MB');
  const magic = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' : bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
  if (!magic) throw new Error('Image bytes do not match content type');
  return bytes;
}

export function availabilityFor({ available, onhand, mode }) {
  const raw = mode === 'stock_available' ? available : (available ?? onhand);
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return { mode, confirmedQty: null, error: 'stock_unavailable' };
  const confirmed = Number(raw);
  if (!Number.isFinite(confirmed)) return { mode, confirmedQty: null, error: 'stock_unavailable' };
  if (mode === 'stock_available' && confirmed <= 0) return { mode, confirmedQty: confirmed, error: 'no_stock_available' };
  if (mode === 'to_order' && confirmed < 0) return { mode, confirmedQty: confirmed, error: 'invalid_stock_quantity' };
  return { mode, confirmedQty: confirmed, error: null };
}

export function publicItem(row) {
  return {
    sku: row.sku,
    title: row.title || '',
    units_of_issue: row.units_of_issue || null,
    price_incl_vat: row.price_incl_vat ?? null,
    recorded_stock: row.recorded_stock ?? null,
    image_url: row.image_url || null,
    category: row.category || '',
    status: row.status || 'archived',
    availability_mode: row.availability_mode || 'positill',
    confirmed_qty: row.confirmed_qty ?? null,
    review_error: row.review_error || null,
    batch_id: row.batch_id || null,
    updated_at: row.updated_at || null,
    version: row.version ?? 1,
  };
}
import { Buffer } from 'node:buffer';

