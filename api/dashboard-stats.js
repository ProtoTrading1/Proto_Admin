import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { getStockClient } from './_stock-client.js';
import { mergeStagedImagesOntoLive } from './_stage-dormant.js';
import { isExpiredStaging } from './_staging-storage.js';

const CACHE_TTL_MS = 60_000;
const IMAGE_COLS = 'image_url_one, image_url_two, image_url_three, image_url_four';
const STAGED_COLS = `sku, barcode, staged_expires_at, ${IMAGE_COLS}`;
const LIVE_COLS = `sku, ${IMAGE_COLS}`;

let cachedPayload = null;
let cachedAt = 0;
let inflight = null;

function getMainClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function countTable(sb, table, filter) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function fetchLiveBySkus(sb, skus) {
  const liveBySku = new Map();
  for (let i = 0; i < skus.length; i += 150) {
    const chunk = skus.slice(i, i + 150);
    const { data, error } = await sb.from('website_stock').select(LIVE_COLS).in('sku', chunk);
    if (error) throw error;
    for (const row of data || []) liveBySku.set(row.sku, row);
  }
  return liveBySku;
}

async function countApproval(sb) {
  const staged = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('archived_products')
      .select(STAGED_COLS)
      .eq('archived_by', 'new-products')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    staged.push(...(data || []));
    if ((data || []).length < PAGE) break;
    from += PAGE;
  }

  const active = staged.filter((row) => !isExpiredStaging(row));
  const skus = active.map((r) => r.sku).filter(Boolean);
  if (!skus.length) return 0;

  const liveBySku = await fetchLiveBySkus(sb, skus);
  let n = 0;
  for (const row of active) {
    const live = liveBySku.get(row.sku);
    if (!live) continue;
    const { appliedSlots } = mergeStagedImagesOntoLive(row, live);
    if (appliedSlots.length) n += 1;
  }
  return n;
}

async function loadStats() {
  const stockSb = getStockClient();
  const mainSb = getMainClient();

  const [
    liveProducts,
    totalArchived,
    dormantArchived,
    recycleBin,
    approvalPending,
    uncategorized,
    customersRes,
    ordersRes,
  ] = await Promise.all([
    countTable(stockSb, 'website_stock'),
    countTable(stockSb, 'archived_products'),
    countTable(stockSb, 'archived_products', (q) => q.eq('archived_by', 'new-products')),
    countTable(stockSb, 'archived_products', (q) => q.eq('archived_by', 'recycle-bin')),
    countApproval(stockSb),
    countTable(stockSb, 'website_stock', (q) => q.or('category.is.null,category.eq.')),
    mainSb.from('customers').select('*', { count: 'exact', head: true }),
    mainSb.from('orders').select('*', { count: 'exact', head: true }),
  ]);

  const archivedProducts = Math.max(0, totalArchived - dormantArchived - recycleBin);

  if (customersRes.error) throw customersRes.error;
  if (ordersRes.error) throw ordersRes.error;

  return {
    liveProducts,
    archivedProducts,
    approvalPending,
    recycleBin,
    uncategorized,
    customers: customersRes.count || 0,
    orders: ordersRes.count || 0,
    fetchedAt: new Date().toISOString(),
  };
}

function getCachedOrInflight(force = false) {
  const now = Date.now();
  if (!force && cachedPayload && now - cachedAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedPayload);
  }
  if (!force && inflight) return inflight;

  inflight = loadStats()
    .then((payload) => {
      cachedPayload = payload;
      cachedAt = Date.now();
      return payload;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Store-wide dashboard counts — never affected by search/filter state. */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') return res.status(405).end();

  const force = req.query?.refresh === '1';

  try {
    const payload = await getCachedOrInflight(force);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('dashboard-stats:', err?.message || err);
    if (cachedPayload) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ...cachedPayload, stale: true });
    }
    return res.status(500).json({ error: err.message || 'Stats fetch failed' });
  }
}
