import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { checkRateLimit } from './_rate-limit.js';
import { applyCodexReferenceMap, prepareCodexSnapshot } from '../lib/analytics-insights.mjs';
import customerAttentionHandler from './customer-attention.js';
import orderAnalyticsHandler from './order-analytics.js';
import searchAnalyticsHandler from './search-analytics-dashboard.js';
import abandonedBasketsHandler from './abandoned-baskets.js';
import { callPreviewAnalyticsGateway, previewAnalyticsGatewayEnabled } from './_analytics-preview-gateway.js';

export const config = { maxDuration: 60 };

export const READ_ONLY_PREVIEW_MESSAGE = 'This preview is read-only. Nothing was changed.';
export const ANALYTICS_FOCUS = new Set(['overview', 'orders', 'customer_attention', 'search', 'baskets']);

export function normalizeAnalyticsFocus(value) {
  const focus = String(value || '').trim().toLowerCase();
  return ANALYTICS_FOCUS.has(focus) ? focus : 'overview';
}

export function focusAnalyticsSnapshot(snapshot, focus) {
  const base = { periodDays: snapshot.periodDays, periodLabel: snapshot.periodLabel, focus };
  if (focus === 'customer_attention') {
    return { ...base, attention: snapshot.attention, orders: { topProducts: snapshot.orders?.topProducts || [], topCategories: snapshot.orders?.topCategories || [] } };
  }
  if (focus === 'orders') return { ...base, orders: snapshot.orders };
  if (focus === 'search') return { ...base, search: snapshot.search, orders: { count: snapshot.orders?.count || 0, revenueExVat: snapshot.orders?.revenueExVat || 0 } };
  if (focus === 'baskets') return { ...base, baskets: snapshot.baskets, orders: { count: snapshot.orders?.count || 0, revenueExVat: snapshot.orders?.revenueExVat || 0 } };
  return { ...snapshot, focus };
}

export function isProductionAnalyticsRuntime(env = process.env) {
  return String(env.VERCEL_ENV || '').trim().toLowerCase() === 'production';
}

export function isAnalyticsWriteRuntime(env = process.env) {
  return isProductionAnalyticsRuntime(env) || previewAnalyticsGatewayEnabled(env);
}

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

export async function buildServerSnapshot(req, periodDays, handlers = {}, periodKey = 'rolling', focus = 'overview') {
  const sources = {
    attention: customerAttentionHandler,
    orders: orderAnalyticsHandler,
    search: searchAnalyticsHandler,
    baskets: abandonedBasketsHandler,
    ...handlers,
  };
  const range = periodKey === 'today' ? 'today' : { 1: 'day', 7: 'week', 30: 'month', 90: 'quarter' }[periodDays];
  const period = periodKey === 'today' ? 'today' : String(periodDays);
  const needsAttention = focus === 'overview' || focus === 'customer_attention';
  const needsOrders = ['overview', 'orders', 'customer_attention', 'search', 'baskets'].includes(focus);
  const needsSearch = focus === 'overview' || focus === 'search';
  const needsBaskets = focus === 'overview' || focus === 'baskets';
  const [attention, orders, search, baskets] = await Promise.all([
    needsAttention ? invokeReadHandler(sources.attention, req, { range }) : {},
    needsOrders ? invokeReadHandler(sources.orders, req, { period }) : {},
    needsSearch ? invokeReadHandler(sources.search, req, { period }) : {},
    needsBaskets ? invokeReadHandler(sources.baskets, req) : {},
  ]);
  return {
    periodDays,
    periodLabel: periodKey === 'today' ? 'Today' : `${periodDays}-day view`,
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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && !isAnalyticsWriteRuntime()) {
    return res.status(409).json({ error: READ_ONLY_PREVIEW_MESSAGE });
  }
  if (!(await requireAdminKey(req, res))) return;
  const admin = await verifyAdminUser(req);
  const requester = admin?.id ? `admin-user:${admin.id}` : 'admin-service';

  if (req.method === 'POST') {
    const limit = await checkRateLimit({ bucket: `codex-analytics:${requester}`, max: 10, windowSeconds: 3600 });
    if (!limit.allowed) return res.status(429).json({ error: 'Codex analysis limit reached. Try again later.' });
    const periodDays = [1, 7, 30, 90].includes(Number(req.body?.periodDays)) ? Number(req.body.periodDays) : 30;
    const periodKey = req.body?.periodKey === 'today' && periodDays === 1 ? 'today' : 'rolling';
    const focus = normalizeAnalyticsFocus(req.body?.focus);
    const sourceSnapshot = previewAnalyticsGatewayEnabled()
      ? await callPreviewAnalyticsGateway('snapshot', { periodDays, periodKey })
      : await buildServerSnapshot(req, periodDays, {}, periodKey, focus);
    const prepared = prepareCodexSnapshot(sourceSnapshot);
    const snapshot = focusAnalyticsSnapshot({ ...prepared.snapshot, periodLabel: sourceSnapshot.periodLabel }, focus);
    const { referenceMap } = prepared;
    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({ snapshot, referenceMap }))
      .digest('hex');
    let job;
    if (previewAnalyticsGatewayEnabled()) {
      job = (await callPreviewAnalyticsGateway('enqueue', { snapshot, referenceMap, snapshotHash, requester })).job;
    } else {
      const supabase = db();
      const { data, error } = await supabase.rpc('enqueue_codex_analytics_job', {
        p_snapshot: snapshot,
        p_reference_map: referenceMap,
        p_snapshot_hash: snapshotHash,
        p_requested_by: requester,
      });
      if (error) return res.status(400).json({ error: error.message });
      job = data?.[0];
    }
    if (!job) return res.status(503).json({ error: 'Codex analytics queue is unavailable.' });
    return res.status(job.status === 'completed' ? 200 : 202).json({ id: job.id, status: job.status, requested_at: job.requested_at });
  }

  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'A valid job id is required.' });
    let data;
    if (previewAnalyticsGatewayEnabled()) {
      data = (await callPreviewAnalyticsGateway('status', { jobId: id })).job;
    } else {
      const supabase = db();
      const result = await supabase.from('codex_analytics_jobs').select('id, status, result, reference_map, error, requested_at, started_at, completed_at').eq('id', id).maybeSingle();
      if (result.error) return res.status(400).json({ error: result.error.message });
      data = result.data;
    }
    if (!data) return res.status(404).json({ error: 'Analytics job not found.' });
    const { reference_map: referenceMap, ...job } = data;
    if (job.result) job.result = applyCodexReferenceMap(job.result, referenceMap);
    return res.status(200).json(job);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
