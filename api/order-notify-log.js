import { requireAdminOrOrderToken, requireAdminAuthType } from './_admin-auth.js';
import { readOrderNotifyLog } from './_site-config.js';

export default async function handler(req, res) {
  const auth = await requireAdminOrOrderToken(req, res);
  if (!auth) return;
  // Reads the notification log for any order id in the query — admin-only,
  // since it is not scoped to the caller's order.
  if (!requireAdminAuthType(auth, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const orderId = String(req.query.orderId || '').trim();
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  try {
    const log = await readOrderNotifyLog(orderId);
    if (!log) {
      return res.status(200).json({ orderId, found: false });
    }
    return res.status(200).json({ orderId, found: true, ...log });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to load notify log' });
  }
}
