import { readApiJson } from './apiError';

const PRODUCT_CODE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

/**
 * Product Intelligence frontend contract.
 *
 * GET /api/product-intelligence?code=:code returns one ProductIntelligence:
 *   { code, website, erp, sources, status }
 *
 * The API is deliberately code-first: `code` is the canonical Positill CODE.
 * This helper does not know whether a field came from SQL, Supabase or another
 * service; that joining belongs to the server-side intelligence layer.
 */
export function normalizePositillCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function productIntelligenceUrl(code) {
  const normalizedCode = normalizePositillCode(code);
  if (!normalizedCode) throw new Error('Enter a Positill CODE.');
  if (!PRODUCT_CODE.test(normalizedCode)) {
    throw new Error('Use a valid Positill CODE without spaces.');
  }
  return `/api/product-intelligence?code=${encodeURIComponent(normalizedCode)}`;
}

export async function fetchProductIntelligence(code, { signal } = {}) {
  const response = await fetch(productIntelligenceUrl(code), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });

  if (response.status === 404) return null;

  const payload = await readApiJson(response, {
    fallback: 'Product Intelligence lookup failed',
  });

  const noWebsiteRecord = payload?.status?.website === 'not_found';
  const noErpRecord = payload?.status?.erp === 'not_found';
  return noWebsiteRecord && noErpRecord ? null : payload;
}
