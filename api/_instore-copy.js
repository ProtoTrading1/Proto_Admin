import { randomUUID } from 'node:crypto';
import { normalizeInstoreCopy } from '../lib/instore-copy.mjs';

export const INSTORE_COPY_COLUMNS = 'sku,title,original_description,price,available_stock,image_url,updated_at';
export function instoreCopyWritesEnabled() {
  // This flag must be scoped to Vercel Production only, just like landed import.
  return process.env.INSTORE_LANDED_IMPORT_MODE === 'production-enabled';
}
export function exactInstoreCopySku(value) {
  if (typeof value !== 'string') return '';
  const sku = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku) ? sku : '';
}
export async function readInstoreCopy(stock, sku) {
  const { data, error } = await stock.from('extended_range_items').select(INSTORE_COPY_COLUMNS).eq('sku', sku).maybeSingle();
  if (error) throw error;
  return data;
}
export async function recordInstoreCopyIntent(stock, { sku, actor, oldValues, copy, operationId = randomUUID() }) {
  const { error } = await stock.from('product_publish_audit').insert({
    sku, action: 'update', source: 'instore_website_wording', publish_mode: 'instore_copy_intent',
    old_values: oldValues, new_values: { operationId, outcome: 'pending', reason: 'Wording reviewed; this intent alone does not confirm a saved or published product.', title: copy.title, original_description: copy.description },
    published_by: actor, published_at: new Date().toISOString(),
  });
  if (error) throw new Error('Could not record the wording review. Nothing was saved.');
  return operationId;
}
export async function saveInstoreCopy(stock, { sku, expectedUpdatedAt, copy: input, actor }) {
  const copy = normalizeInstoreCopy(input);
  const before = await readInstoreCopy(stock, sku);
  if (!before) return { status: 404, error: 'This exact code is not in Instore.' };
  if (!expectedUpdatedAt || before.updated_at !== expectedUpdatedAt) return { status: 409, error: 'This item changed since you opened it. Reload it and review your wording again.' };
  if (before.title === copy.title && before.original_description === copy.description) return { status: 200, ok: true, item: before, unchanged: true };
  const operationId = await recordInstoreCopyIntent(stock, { sku, actor, oldValues: { title: before.title, original_description: before.original_description, updated_at: before.updated_at }, copy });
  const { data: item, error } = await stock.from('extended_range_items')
    .update({ title: copy.title, original_description: copy.description, updated_at: new Date(Math.max(Date.now(), Date.parse(before.updated_at) + 1)).toISOString() })
    .eq('sku', sku).eq('updated_at', expectedUpdatedAt).select(INSTORE_COPY_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!item) return { status: 409, error: 'This item changed while saving. Reload it and review your wording again.' };
  // Saving already succeeded. Never report it as a failed save if secondary
  // audit/cache work fails: that would invite an unsafe blind retry.
  const warnings = [];
  try {
    const result = await stock.from('product_publish_audit').insert({
      sku, action: 'update', source: 'instore_website_wording', publish_mode: 'instore_copy_saved',
      old_values: { title: before.title, original_description: before.original_description },
      new_values: { operationId, outcome: 'published', title: item.title, original_description: item.original_description },
      published_by: actor, published_at: new Date().toISOString(),
    });
    if (result.error) throw result.error;
  } catch { warnings.push('Saved, but the completion audit could not be recorded; the reviewed before/after wording is retained in the intent audit.'); }
  try {
    const result = await stock.from('instore_catalogue_state').update({ refreshed_at: null }).eq('id', true).select('id').maybeSingle();
    if (result.error || !result.data) throw new Error('Catalogue refresh not confirmed');
  } catch { warnings.push('Saved, but the storefront refresh could not be requested. Check the website again after its normal catalogue refresh.'); }
  return { status: 200, ok: true, item, warning: warnings.join(' ') || null };
}
