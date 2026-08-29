import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { checkRateLimit } from './_rate-limit.js';
import { applyCodexReferenceMap, prepareCodexSnapshot } from '../lib/analytics-insights.mjs';
import customerAttentionHandler from './customer-attention.js';
import orderAnalyticsHandler from './order-analytics.js';
import searchAnalyticsHandler from './search-analytics-dashboard.js';
import abandonedBasketsHandler from './abandoned-baskets.js';

export const config = { maxDuration: 60 };

function db() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function invokeReadHandler(handler, req, query = {}) {
  let statusCode = 200;
  let body = null;
  const response = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    end(payload) { body = payload; return this; },
  };
  await handler({ method: 'GET', headers: req.headers, query }, response);
  if (statusCode >= 400) throw new Error(body?.error || `Analytics source returned ${statusCode}`);
  return body || {};
}

export async function buildServerSnapshot(req, periodDays, handlers = {}) {
  const sources = {
    attention: customerAttentionHandler,
    orders: orderAnalyticsHandler,
    search: searchAnalyticsHandler,
    baskets: abandonedBasketsHandler,
    ...handlers,
  };
  const range = { 7: 'week', 30: 'month', 90: 'quarter' }[periodDays];
  const [attention, orders, search, baskets] = await Promise.all([
    invokeReadHandler(sources.attention, req, { range }),
    invokeReadHandler(sources.orders, req, { period: String(periodDays) }),
    invokeReadHandler(sources.search, req, { period: String(periodDays) }),
    invokeReadHandler(sources.baskets, req),
  ]);
  return {
    periodDays,
    attention: {
      available: attention.available,
      totalActiveSeconds: attention.totalActiveSeconds,
      products: attention.products,
      categories: attention.categories,
    },
    orders: {
      summary: orders.summary,
      topProducts: orders.topOrderedProducts,
      topCategories: orders.topOrderedCategories,
    },
    search: { kpis: search.kpis, zeroResultTerms: search.zeroResultTerms },
    baskets: baskets.summary,
  };
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const supabase = db();
  const admin = await verifyAdminUser(req);
  const requester = admin?.id ? `admin-user:${admin.id}` : 'admin-service';

  if (req.method === 'POST') {
    const limit = await checkRateLimit({ bucket: `codex-analytics:${requester}`, max: 10, windowSeconds: 3600 });
    if (!limit.allowed) return res.status(429).json({ error: 'Codex analysis limit reached. Try again later.' });
    const periodDays = [7, 30, 90].includes(Number(req.body?.periodDays)) ? Number(req.body.periodDays) : 30;
    const { snapshot, referenceMap } = prepareCodexSnapshot(await buildServerSnapshot(req, periodDays));
    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({ snapshot, referenceMap }))
      .digest('hex');
    const { data, error } = await supabase.rpc('enqueue_codex_analytics_job', {
      p_snapshot: snapshot,
      p_reference_map: referenceMap,
      p_snapshot_hash: snapshotHash,
      p_requested_by: requester,
    });
    if (error) return res.status(400).json({ error: error.message });
    const job = data?.[0];
    if (!job) return res.status(503).json({ error: 'Codex analytics queue is unavailable.' });
    return res.status(job.status === 'completed' ? 200 : 202).json({ id: job.id, status: job.status, requested_at: job.requested_at });
  }

  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'A valid job id is required.' });
    const { data, error } = await supabase.from('codex_analytics_jobs').select('id, status, result, reference_map, error, requested_at, started_at, completed_at').eq('id', id).maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Analytics job not found.' });
    const { reference_map: referenceMap, ...job } = data;
    if (job.result) job.result = applyCodexReferenceMap(job.result, referenceMap);
    return res.status(200).json(job);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
