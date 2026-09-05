import { createClient } from '@supabase/supabase-js';
import { requireOwner } from './_admin-auth.js';
import { fetchProductLookupMap, findProductBySku } from './_sku-match.js';
import { resolveProductByCode } from './_sql-provider.js';

const MAX_ITEMS = 500;
const clean = (value) => String(value ?? '').trim().toUpperCase();

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .slice(0, MAX_ITEMS)
    .map((item) => ({ sku: clean(item?.sku), barcode: clean(item?.barcode) }))
    .filter((item) => item.sku && item.barcode);
  if (!items.length) return res.status(200).json({ rows: [] });

  try {
    const sb = getStockClient();
    const skus = [...new Set(items.map((item) => item.sku))];
    const barcodes = [...new Set(items.map((item) => item.barcode))];
    const [{ data: existing, error: existingError }, { data: archived, error: archivedError }] = await Promise.all([
      sb.from('website_stock').select('sku, title, barcode').in('sku', skus),
      sb.from('archived_products').select('sku, title, barcode, archived_by').in('sku', skus),
    ]);
    if (existingError || archivedError) throw existingError || archivedError;
    const existingBySku = new Map((existing || []).map((row) => [clean(row.sku), { ...row, location: 'website' }]));
    for (const row of archived || []) {
      if (!existingBySku.has(clean(row.sku))) existingBySku.set(clean(row.sku), { ...row, location: 'archive' });
    }

    const productMap = await fetchProductLookupMap(
      sb,
      barcodes,
      'sku, sell_price, stock_qty, available_stock, units_of_issue',
    );
    const sourceByBarcode = new Map();
    await Promise.all(barcodes.map(async (barcode) => {
      const canonical = findProductBySku(productMap, barcode);
      const positill = await resolveProductByCode(barcode).catch(() => ({ product: null, dataSource: null }));
      sourceByBarcode.set(barcode, { canonical, positill });
    }));

    const rows = items.map((item) => {
      const existingRow = existingBySku.get(item.sku) || null;
      const source = sourceByBarcode.get(item.barcode) || {};
      const canonical = source.canonical || null;
      const positill = source.positill?.product || null;
      return {
        sku: item.sku,
        barcode: item.barcode,
        existing: Boolean(existingRow),
        existingLocation: existingRow?.location || null,
        existingTitle: existingRow?.title || '',
        archivedBy: existingRow?.location === 'archive' ? (existingRow.archived_by || '') : '',
        sourceFound: Boolean(canonical),
        sourceStatus: source.positill?.dataSource || (canonical ? 'catalogue' : null),
        price: Number(canonical?.sell_price) || 0,
        stockQty: Number(positill?.onhand ?? canonical?.stock_qty) || 0,
        availableStock: Number(positill?.available ?? canonical?.available_stock ?? canonical?.stock_qty) || 0,
        unitsOfIssue: canonical?.units_of_issue || 'EACH',
      };
    });
    return res.status(200).json({ rows });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Could not preview the import' });
  }
}
