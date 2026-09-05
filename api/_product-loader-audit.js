/** Audit helpers for Product Loader publish history (uses product_publish_audit). */

export async function logProductLoaderAudit(sb, {
  sku,
  action = 'update',
  source = 'manual_product_loader',
  publishMode = 'direct',
  imageSlot = null,
  imageSource = null,
  categoryConfidence = null,
  oldValues = null,
  newValues = {},
  publishedBy = null,
}) {
  const cleanSku = String(sku || '').trim().toUpperCase();
  if (!cleanSku) return;

  const payload = {
    sku: cleanSku,
    action: action === 'create' ? 'create' : 'update',
    source: String(source || 'manual_product_loader'),
    publish_mode: String(publishMode || 'direct'),
    image_slot: imageSlot != null ? Number(imageSlot) : null,
    image_source: imageSource ? String(imageSource) : null,
    category_confidence: categoryConfidence != null ? Number(categoryConfidence) : null,
    old_values: oldValues,
    new_values: newValues,
    published_by: publishedBy ? String(publishedBy) : null,
    published_at: new Date().toISOString(),
  };

  try {
    const { error } = await sb.from('product_publish_audit').insert(payload);
    if (error) console.error('product_publish_audit insert failed:', error.message);
  } catch (err) {
    console.error('product_publish_audit insert failed:', err?.message || err);
  }
}

/**
 * Write workflow evidence that must exist before a safety-sensitive action.
 * The legacy helper deliberately best-effort logs routine Product Loader
 * publishes; Image Processing Centre approval/apply is stricter and must stop
 * if its audit evidence cannot be written.
 */
export async function writeRequiredProductPublishAudit(sb, input) {
  const cleanSku = String(input?.sku || '').trim().toUpperCase();
  if (!cleanSku) throw new Error('An audit SKU is required');
  const payload = {
    sku: cleanSku,
    action: input?.action === 'create' ? 'create' : 'update',
    source: String(input?.source || 'image_processing_centre'),
    publish_mode: String(input?.publishMode || 'ipc_review'),
    image_slot: input?.imageSlot != null ? Number(input.imageSlot) : null,
    image_source: input?.imageSource ? String(input.imageSource) : null,
    category_confidence: input?.categoryConfidence != null ? Number(input.categoryConfidence) : null,
    old_values: input?.oldValues ?? null,
    new_values: input?.newValues ?? {},
    published_by: input?.publishedBy ? String(input.publishedBy) : null,
    published_at: new Date().toISOString(),
  };
  const { error } = await sb.from('product_publish_audit').insert(payload);
  if (error) throw new Error(`Could not record required image-processing audit evidence: ${error.message}`);
}

export function auditOutcomeFromRow(row) {
  const outcome = row?.new_values?.outcome;
  if (outcome === 'dormant') return 'dormant';
  if (outcome === 'archived') return 'archived';
  if (outcome === 'failed') return 'failed';
  if (row?.action === 'create' || row?.action === 'update') return 'published';
  return 'published';
}
