import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { summarizeInstoreAnalytics } from '../lib/instore-analytics.mjs';

const PERIODS = new Set([7, 30, 90]);
const PAGE = 1000;
const MAX_ROWS = 10000;

function portalClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function readAll(build) {
  const first = await build().range(0, PAGE - 1);
  if (first.error) throw first.error;
  if (!Number.isInteger(first.count)) throw new Error('source count unavailable');
  if (first.count > MAX_ROWS) throw new Error('safe query limit exceeded');
  if (first.count <= PAGE) return first.data || [];
  const offsets = Array.from({ length: Math.ceil(first.count / PAGE) - 1 }, (_, index) => (index + 1) * PAGE);
  const pages = await Promise.all(offsets.map((offset) => build().range(offset, offset + PAGE - 1)));
  const rows = [...(first.data || [])];
  for (const page of pages) {
    if (page.error) throw page.error;
    rows.push(...(page.data || []));
  }
  if (rows.length !== first.count) throw new Error('source changed during read');
  return rows;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = Number(req.query?.period);
  const period = PERIODS.has(parsed) ? parsed : 30;
  const asOf = new Date().toISOString();
  const since = new Date(Date.parse(asOf) - period * 86400000).toISOString();
  try {
    const portal = portalClient();
    const stock = getStockClient();
    const [products, events, orders] = await Promise.all([
      readAll(() => stock.from('extended_range_items').select('sku, title', { count: 'exact' }).order('sku', { ascending: true })),
      readAll(() => portal.from('analytics_events')
        .select('id, event_type, entity_id, created_at', { count: 'exact' })
        .eq('event_type', 'product_view')
        .gte('created_at', since).lte('created_at', asOf)
        .order('created_at', { ascending: true }).order('id', { ascending: true })),
      readAll(() => portal.from('orders')
        .select('id, created_at, status, final_items, original_items, items', { count: 'exact' })
        .gte('created_at', since).lte('created_at', asOf)
        .order('created_at', { ascending: true }).order('id', { ascending: true })),
    ]);
    return res.status(200).json({
      period, since, asOf, ...summarizeInstoreAnalytics({ products, events, orders, since, asOf }),
      measurement: {
        pageViews: 'Unavailable: historical category events can repeat when taxonomy refreshes and must not be presented as visits.',
        productViews: 'Recorded product-open events whose exact SKU is currently in Instore; repeat opens are counted.',
        orders: 'Orders containing at least one currently indexed Instore SKU; cancelled, refunded and rejected orders are excluded. Not attributed to an Instore visit.',
        cartAdds: 'Unavailable: the current cart event has no product code.',
        uniqueVisitors: 'Unavailable: anonymous and session identifiers are not reliably captured for Instore.',
      },
    });
  } catch (error) {
    console.error('instore-analytics:', error?.message || error);
    return res.status(503).json({ error: error?.message === 'safe query limit exceeded'
      ? 'Instore analytics exceeded the safe query limit. No partial figures are shown.'
      : 'Instore analytics could not be loaded. No figures are shown.' });
  }
}
