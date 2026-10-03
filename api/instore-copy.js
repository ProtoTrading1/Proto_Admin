import { requireOwner, verifyAdminUser } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { exactInstoreCopySku, instoreCopyWritesEnabled, readInstoreCopy, saveInstoreCopy } from './_instore-copy.js';
import { instoreCopyError } from '../lib/instore-copy.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await requireOwner(req, res))) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const sku = exactInstoreCopySku(req.method === 'GET' ? req.query?.sku : req.body?.sku);
  if (!sku) return res.status(400).json({ error: 'Enter the exact Instore product code.' });
  if (req.method === 'POST') {
    if (!instoreCopyWritesEnabled()) return res.status(403).json({ error: 'Saving website wording is disabled in this preview.' });
    const error = instoreCopyError(req.body?.copy);
    if (error) return res.status(400).json({ error });
    if (typeof req.body?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) return res.status(400).json({ error: 'Reload the product before saving.' });
  }
  try {
    const stock = getStockClient();
    if (req.method === 'GET') {
      const item = await readInstoreCopy(stock, sku);
      return item ? res.status(200).json({ item, canEdit: instoreCopyWritesEnabled() }) : res.status(404).json({ error: 'This exact code is not in Instore. Main catalogue products are edited in Product Manager.' });
    }
    const actor = (await verifyAdminUser(req))?.email || 'owner-admin-key';
    const { status, ...body } = await saveInstoreCopy(stock, { sku, expectedUpdatedAt: req.body.expectedUpdatedAt, copy: req.body.copy, actor });
    return res.status(status).json(body);
  } catch (error) {
    console.error('instore-copy:', error?.message || error);
    return res.status(500).json({ error: 'The wording save could not be confirmed. Your draft is kept; reload the item to check its saved wording before retrying.' });
  }
}
