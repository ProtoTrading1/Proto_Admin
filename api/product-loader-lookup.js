import { createClient } from '@supabase/supabase-js';
import { requireOwner } from './_admin-auth.js';
import { isSqlConfigured } from './_sql-provider.js';
import { fetchDormantSkuSet, resolveProductLoaderMatch, SLOT_FIELDS } from './_product-loader-lookup.js';

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
  if (req.method !== 'GET') return res.status(405).end();

  const rawInput = String(req.query.code || '').trim();
  if (!rawInput) return res.status(400).json({ error: 'code is required' });
  const code = rawInput.toUpperCase();
  const displayCode = rawInput;

  const sqlAvailable = isSqlConfigured();
  const sb = getStockClient();

  const dormantSkus = await fetchDormantSkuSet(sb).catch(() => new Set());
  const match = await resolveProductLoaderMatch(sb, {
    code,
    displayCode,
    imageSlot: Number(req.query.imageSlot) || 1,
    dormantSkus,
  });

  const existingImages = SLOT_FIELDS.map((f) => match.websiteRow?.[f]).filter(Boolean);
  const warnings = [...(match.warnings || [])];

  return res.status(200).json({
    sqlRow: match.sqlRow,
    websiteRow: match.websiteRow,
    existingImages,
    matchedBy: match.matchedBy,
    dataSource: match.sqlRow ? 'sql' : 'website_stock',
    sqlAvailable,
    warnings,
    resolvedCode: match.code,
    canPublish: match.canPublish,
    websiteStatus: match.websiteStatus,
    department: match.department,
    category: match.category,
    stockOnHand: match.stockOnHand,
    price: match.price,
    priceSource: match.priceSource,
    priceSourceLabel: match.priceSourceLabel,
    positillSource: match.positillSource,
    bridgeAttempted: match.bridgeAttempted,
    erpPriceExVat: match.erpPriceExVat,
    productSellPrice: match.productSellPrice,
    needsReview: match.needsReview,
  });
}
