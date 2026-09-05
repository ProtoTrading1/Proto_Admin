import { requireAdminKey } from './_admin-auth.js';
import { getStockClient } from './_image-gen-cost.js';
import { repairLiveStagingUrls } from './_staging-storage.js';

/** One-shot repair: website_stock rows pointing at deleted staging/* URLs. */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  try {
    const result = await repairLiveStagingUrls(getStockClient());
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('repair-live-staging-urls:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Repair failed' });
  }
}
