import { requireAdminKey } from './_admin-auth.js';
import { readOrderConfirmationSent, markOrderConfirmationSent } from './_order-confirmation-sent.js';

export { readOrderConfirmationSent as readConfirmationSent } from './_order-confirmation-sent.js';

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const ids = String(req.query?.ids || req.query?.id || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'id or ids required' });

    const out = {};
    await Promise.all(ids.map(async (orderId) => {
      const meta = await readOrderConfirmationSent(orderId);
      if (meta) out[orderId] = meta;
    }));
    return res.status(200).json({ confirmations: out });
  }

  if (req.method === 'POST') {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    try {
      const meta = await markOrderConfirmationSent(orderId);
      return res.status(200).json({ ok: true, orderId, sentAt: meta.sentAt });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
