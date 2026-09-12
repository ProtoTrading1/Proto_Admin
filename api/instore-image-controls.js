import { requireOwner, verifyAdminUser } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

function skuFrom(value) {
  const sku = String(value || '').trim().toUpperCase();
  return SKU_PATTERN.test(sku) ? sku : '';
}

function text(value, max = 500) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const sku = skuFrom(req.query?.sku || req.body?.sku);
  if (!sku) return res.status(400).json({ error: 'A valid Instore SKU is required.' });

  const stock = getStockClient();
  try {
    if (req.method === 'GET') {
      const [itemResult, controlResult, eventsResult] = await Promise.all([
        stock.from('extended_range_items')
          .select('sku, title, original_description, price, available_stock, category, image_url, image_review_status, visibility_status, is_active')
          .eq('sku', sku).maybeSingle(),
        stock.from('instore_image_controls')
          .select('sku, status, original_image_url, reason, updated_by, updated_at, created_at')
          .eq('sku', sku).maybeSingle(),
        stock.from('instore_image_control_events')
          .select('id, previous_status, next_status, reason, actor, created_at')
          .eq('sku', sku).order('created_at', { ascending: false }).limit(12),
      ]);
      const error = itemResult.error || controlResult.error || eventsResult.error;
      if (error) throw error;
      if (!itemResult.data) return res.status(404).json({ error: 'This SKU is not in the Instore image index.' });
      return res.status(200).json({
        item: itemResult.data,
        control: controlResult.data || { sku, status: 'visible' },
        events: eventsResult.data || [],
      });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const action = String(req.body?.action || '').trim().toLowerCase();
    const status = action === 'hide' ? 'hidden' : action === 'restore' ? 'visible' : '';
    if (!status) return res.status(400).json({ error: 'action must be hide or restore.' });
    const reason = text(req.body?.reason);
    if (status === 'hidden' && !reason) return res.status(400).json({ error: 'A reason is required before hiding an image.' });

    const { data: item, error: itemError } = await stock.from('extended_range_items')
      .select('sku, image_url').eq('sku', sku).maybeSingle();
    if (itemError) throw itemError;
    if (!item) return res.status(404).json({ error: 'This SKU is not in the Instore image index.' });

    const actor = text((await verifyAdminUser(req))?.email, 320) || 'owner-admin-key';
    const { data: control, error } = await stock.rpc('set_instore_image_control', {
      p_sku: sku,
      p_status: status,
      p_reason: reason || null,
      p_actor: actor,
      p_original_image_url: text(item.image_url, 2000) || null,
    });
    if (error) throw error;
    return res.status(200).json({ ok: true, item: { sku, image_url: item.image_url || null }, control });
  } catch (error) {
    console.error('instore-image-controls:', error?.message || error);
    return res.status(500).json({ error: 'The Instore image control could not be completed. No product, price or stock record was changed.' });
  }
}
