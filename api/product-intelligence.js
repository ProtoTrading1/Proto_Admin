import { requireOwner } from './_admin-auth.js';
import { buildProductIntelligence } from './_product-intelligence.js';
import { resolveProductByCode } from './_sql-provider.js';
import { getStockClient } from './_stock-client.js';

const PRODUCT_CODE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = String(req.query?.code || '').trim().toUpperCase();
  if (!PRODUCT_CODE.test(code)) {
    return res.status(400).json({ error: 'A valid product code is required' });
  }

  try {
    let stockClient = null;
    try {
      stockClient = getStockClient();
    } catch {
      // Keep ERP-only results available when the website catalogue is not
      // configured; the combined contract reports that source as unavailable.
    }
    const intelligence = await buildProductIntelligence({
      code,
      stockClient,
      resolveErp: resolveProductByCode,
    });
    return res.status(200).json(intelligence);
  } catch (error) {
    console.error('product intelligence catalogue lookup failed:', error);
    return res.status(503).json({ error: 'Product catalogue is temporarily unavailable' });
  }
}
