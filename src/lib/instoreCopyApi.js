import { readApiJson } from './apiError.js';
import { normalizeInstoreCopy } from '../../lib/instore-copy.mjs';

export async function loadInstoreCopy(sku) {
  const res = await fetch(`/api/instore-copy?sku=${encodeURIComponent(sku)}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  const json = await readApiJson(res, { fallback: 'Could not load this Instore product.' });
  if (json.item?.sku !== sku || typeof json.item.updated_at !== 'string') throw new Error('The server did not confirm this exact Instore code.');
  return json;
}
export async function updateInstoreCopy(item, copy) {
  const expected = normalizeInstoreCopy(copy);
  const res = await fetch('/api/instore-copy', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: item.sku, expectedUpdatedAt: item.updated_at, copy: expected }) });
  const json = await readApiJson(res, { fallback: 'The wording save could not be confirmed. Reload the item before retrying.' });
  if (json.ok !== true || json.item?.sku !== item.sku || json.item.title !== expected.title || json.item.original_description !== expected.description || typeof json.item.updated_at !== 'string') throw new Error('The server did not confirm the saved wording. Reload the item before retrying.');
  return json;
}
