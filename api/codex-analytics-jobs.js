import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { getAdminRole, requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { checkRateLimit } from './_rate-limit.js';
import { applyCodexReferenceMap, prepareCodexSnapshot } from '../lib/analytics-insights.mjs';
import customerAttentionHandler from './customer-attention.js';
import orderAnalyticsHandler from './order-analytics.js';
import searchAnalyticsHandler from './search-analytics-dashboard.js';
import abandonedBasketsHandler from './abandoned-baskets.js';
import backendHealthHandler from './backend-health.js';
import imageProcessingHandler from './image-processing-jobs.js';
import dashboardStatsHandler from './dashboard-stats.js';
import featuredProductsHandler from './featured-products.js';
import specialsHandler from './specials.js';
import bannerHandler from './banner.js';
import emailCampaignsHandler from './email-campaigns.js';
import productLoaderHistoryHandler from './product-loader-publish-history.js';
import adminOrdersHandler from './admin-orders.js';
import { callPreviewAnalyticsGateway, isProductionAnalyticsRuntime, previewAnalyticsGatewayEnabled } from './_analytics-preview-gateway.js';
import { APOLLO_SOURCE_IDS, filterApolloSourcesForRole } from '../lib/apollo-source-catalog.mjs';

export { isProductionAnalyticsRuntime } from './_analytics-preview-gateway.js';

export const config = { maxDuration: 60 };

export const READ_ONLY_PREVIEW_MESSAGE = 'This preview is read-only. Nothing was changed.';
export const ANALYTICS_FOCUS = new Set(['overview', 'orders', 'customer_attention', 'search', 'baskets', 'catalogue', 'customers', 'crm', 'site_content', 'product_loader', 'fulfillment', 'operations']);

export function normalizeAnalyticsFocus(value) {
  const focus = String(value || '').trim().toLowerCase();
  return ANALYTICS_FOCUS.has(focus) ? focus : 'overview';
}

const APOLLO_SOURCES = new Set(APOLLO_SOURCE_IDS);
const APOLLO_WRITE_INTENT = /\b(delete|archive|publish|send|change|edit|update|approve|reject|refund|cancel|move|upload|remove)\b/i;
const APOLLO_PERSONAL_DATA = /\b(email address|phone number|mobile number|street address|customer address|contact details|personal details|named customer|customer name)\b/i;
const APOLLO_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const APOLLO_ZA_PHONE = /(?:\+?27|0)[\s()-]*\d(?:[\s()-]*\d){8}/;
const APOLLO_NAMED_SUBJECT = /\b(?:customer|company|account)\s+(?!(?:attention|interest|activity|analytics|orders?|sales|revenue|views?|count|counts|total|totals|performance|health)\b)(?:named\s+|called\s+|#?[A-Z0-9])/i;
const APOLLO_STREET_ADDRESS = /\b\d{1,5}\s+[A-Z][A-Z .'-]{1,60}\s+(?:street|road|avenue|drive|lane|close|boulevard|way)\b/i;

function assertAggregateReadOnlyText(value) {
  if (APOLLO_WRITE_INTENT.test(value)) throw new Error('Apollo accepts read-only questions only.');
  if (APOLLO_PERSONAL_DATA.test(value) || APOLLO_EMAIL.test(value) || APOLLO_ZA_PHONE.test(value) || APOLLO_NAMED_SUBJECT.test(value) || APOLLO_STREET_ADDRESS.test(value)) {
    throw new Error('Apollo accepts aggregate questions without personal customer details only.');
  }
}

export function normalizeApolloRequest(body = {}, approvedSources = APOLLO_SOURCES) {
  const question = String(body.question || '').trim();
  if (!question || question.length > 600) throw new Error('Apollo requires a question of 600 characters or fewer.');
  if (body.mode !== 'read_only') throw new Error('Apollo accepts read-only analysis requests only.');
  assertAggregateReadOnlyText(question);
  const rawContext = Array.isArray(body.context) ? body.context : [];
  if (rawContext.length > 4) throw new Error('Apollo conversation context is too large.');
  let contextCharacters = 0;
  const context = rawContext.map((turn) => {
    const role = String(turn?.role || '');
    const content = String(turn?.content || '').trim();
    if (!['user', 'assistant'].includes(role) || !content || content.length > 280) throw new Error('Apollo conversation context is invalid.');
    assertAggregateReadOnlyText(content);
    contextCharacters += content.length;
    return {
      role,
      content,
      sourcePlan: [...new Set((Array.isArray(turn.sourcePlan) ? turn.sourcePlan : []).filter((source) => approvedSources.has(source)))],
    };
  });
  if (contextCharacters > 1000) throw new Error('Apollo conversation context is too large.');
  const sourcePlan = [...new Set((Array.isArray(body.sourcePlan) ? body.sourcePlan : []).filter((source) => approvedSources.has(source)))];
  if (!sourcePlan.length) throw new Error('Apollo requires at least one approved read-only source.');
  return { mode: 'read_only', question, context, sourcePlan };
}

export function focusAnalyticsSnapshot(snapshot, focus) {
  const base = { periodDays: snapshot.periodDays, periodLabel: snapshot.periodLabel, focus, apolloRequest: snapshot.apolloRequest };
  if (focus === 'customer_attention') {
    return { ...base, attention: snapshot.attention, orders: { topProducts: snapshot.orders?.topProducts || [], topCategories: snapshot.orders?.topCategories || [] } };
  }
  if (focus === 'orders') return { ...base, orders: snapshot.orders };
  if (focus === 'search') return { ...base, search: snapshot.search, orders: { count: snapshot.orders?.count || 0, revenueExVat: snapshot.orders?.revenueExVat || 0 } };
  if (focus === 'baskets') return { ...base, baskets: snapshot.baskets, orders: { count: snapshot.orders?.count || 0, revenueExVat: snapshot.orders?.revenueExVat || 0 } };
  if (focus === 'catalogue') return { ...base, business: { catalogue: snapshot.business?.catalogue, archive: snapshot.business?.archive } };
  if (['customers', 'crm', 'site_content', 'product_loader', 'fulfillment'].includes(focus)) {
    return { ...base, business: { [focus]: snapshot.business?.[focus] } };
  }
  if (focus === 'operations') return { ...base, operations: snapshot.operations, business: snapshot.business };
  return { ...snapshot, focus };
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
  if (body?.available === false) throw new Error('A required Apollo data source is unavailable. No analysis was queued.');
  return body || {};
}

async function settleRead(handler, req, query = {}) {
  try { return { ok: true, data: await invokeReadHandler(handler, req, query) }; }
  catch (error) { return { ok: false, reason: String(error?.message || 'source_unavailable').slice(0, 120) }; }
}

function sumCampaignEvents(campaigns = []) {
  const result = { delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 };
  for (const campaign of campaigns) {
    for (const key of Object.keys(result)) result[key] += Math.max(0, Number(campaign?.events?.[key]) || 0);
  }
  return result;
}

function sourceResult(result, collectedAt, metrics = {}) {
  return result?.ok
    ? { source: { status: 'available', collectedAt, complete: true, timezone: 'Africa/Johannesburg' }, ...metrics }
    : { source: { status: 'unavailable', collectedAt, complete: false, timezone: 'Africa/Johannesburg', reason: result?.reason || 'source_unavailable' } };
}

export async function buildBusinessSnapshot(req, sourcePlan = [], handlers = {}) {
  const requested = new Set(sourcePlan);
  const wantsDashboard = ['catalogue', 'archive', 'customers'].some((id) => requested.has(id));
  const wantsContent = requested.has('site_content');
  const sources = {
    dashboard: dashboardStatsHandler,
    featured: featuredProductsHandler,
    specials: specialsHandler,
    banner: bannerHandler,
    campaigns: emailCampaignsHandler,
    loader: productLoaderHistoryHandler,
    fulfillment: adminOrdersHandler,
    ...handlers,
  };
  const [dashboard, featured, specials, banner, campaigns, loader, fulfillment] = await Promise.all([
    wantsDashboard ? settleRead(sources.dashboard, req) : null,
    wantsContent ? settleRead(sources.featured, req) : null,
    wantsContent ? settleRead(sources.specials, req) : null,
    wantsContent ? settleRead(sources.banner, req) : null,
    requested.has('crm') ? settleRead(sources.campaigns, req) : null,
    requested.has('product_loader') ? settleRead(sources.loader, req, { limit: '200', offset: '0' }) : null,
    requested.has('fulfillment') ? settleRead(sources.fulfillment, req, { page: '1', pageSize: '1', tab: 'all' }) : null,
  ]);
  const collectedAt = new Date().toISOString();
  const result = {};
  if (requested.has('catalogue')) result.catalogue = sourceResult(dashboard, collectedAt, {
    liveProducts: Number(dashboard?.data?.liveProducts) || 0,
    uncategorized: Number(dashboard?.data?.uncategorized) || 0,
  });
  if (requested.has('archive')) result.archive = sourceResult(dashboard, collectedAt, {
    archivedProducts: Number(dashboard?.data?.archivedProducts) || 0,
    approvalPending: Number(dashboard?.data?.approvalPending) || 0,
    recycleBin: Number(dashboard?.data?.recycleBin) || 0,
  });
  if (requested.has('customers')) result.customers = sourceResult(dashboard, collectedAt, {
    total: Number(dashboard?.data?.customers) || 0,
  });
  if (wantsContent) {
    const contentOk = featured?.ok && specials?.ok && banner?.ok;
    result.site_content = sourceResult(contentOk ? { ok: true } : { ok: false, reason: 'one_or_more_content_sources_unavailable' }, collectedAt, {
      featuredProducts: Array.isArray(featured?.data?.items) ? featured.data.items.length : 0,
      specials: Array.isArray(specials?.data?.items) ? specials.data.items.length : 0,
      bannerConfigured: Boolean(String(banner?.data?.title || '').trim() || String(banner?.data?.body || '').trim() || String(banner?.data?.imageUrl || '').trim()),
    });
  }
  if (requested.has('crm')) {
    const rows = Array.isArray(campaigns?.data?.campaigns) ? campaigns.data.campaigns : [];
    result.crm = sourceResult(campaigns, collectedAt, { campaigns: rows.length, events: sumCampaignEvents(rows) });
  }
  if (requested.has('product_loader')) {
    const rows = Array.isArray(loader?.data?.rows) ? loader.data.rows : [];
    const outcomes = rows.reduce((counts, row) => {
      const key = ['published', 'archived', 'failed', 'skipped'].includes(String(row?.action || '').toLowerCase()) ? String(row.action).toLowerCase() : 'other';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    result.product_loader = sourceResult(loader, collectedAt, { totalEvents: Number(loader?.data?.total) || rows.length, sampledEvents: rows.length, outcomes });
  }
  if (requested.has('fulfillment')) {
    const counts = fulfillment?.data?.tabCounts || {};
    result.fulfillment = sourceResult(fulfillment, collectedAt, {
      total: Number(fulfillment?.data?.total) || Number(counts.all) || 0,
      new: Number(counts.new) || 0,
      handedOver: Number(counts.handed) || 0,
      inProgress: Number(counts.progress) || 0,
      sent: Number(counts.sent) || 0,
      paid: Number(counts.paid) || 0,
    });
  }
  if (requested.has('buying')) result.buying = { source: { status: 'planned', collectedAt, complete: false, timezone: 'Africa/Johannesburg', reason: 'buying_data_source_not_connected' } };
  if (requested.has('pricing')) result.pricing = { source: { status: 'unavailable', collectedAt, complete: false, timezone: 'Africa/Johannesburg', reason: 'aggregate_pricing_source_not_connected' } };
  return result;
}

export async function buildServerSnapshot(req, periodDays, handlers = {}, periodKey = 'rolling', focus = 'overview', sourcePlan = []) {
  const sources = {
    attention: customerAttentionHandler,
    orders: orderAnalyticsHandler,
    search: searchAnalyticsHandler,
    baskets: abandonedBasketsHandler,
    health: backendHealthHandler,
    images: imageProcessingHandler,
    ...handlers,
  };
  const range = periodKey === 'today' ? 'today' : { 1: 'day', 7: 'week', 30: 'month', 90: 'quarter' }[periodDays];
  const period = periodKey === 'today' ? 'today' : String(periodDays);
  const needsAttention = focus === 'overview' || focus === 'customer_attention';
  const needsOrders = ['overview', 'orders', 'customer_attention', 'search', 'baskets'].includes(focus);
  const needsSearch = focus === 'overview' || focus === 'search';
  const needsBaskets = focus === 'overview' || focus === 'baskets';
  const needsHealth = sourcePlan.includes('backend_health');
  const needsImages = sourcePlan.includes('image_processing');
  const [attention, orders, search, baskets, health, images, business] = await Promise.all([
    needsAttention ? invokeReadHandler(sources.attention, req, { range }) : {},
    needsOrders ? invokeReadHandler(sources.orders, req, { period }) : {},
    needsSearch ? invokeReadHandler(sources.search, req, { period }) : {},
    needsBaskets ? invokeReadHandler(sources.baskets, req) : {},
    needsHealth ? invokeReadHandler(sources.health, req) : {},
    needsImages ? invokeReadHandler(sources.images, req) : {},
    buildBusinessSnapshot(req, sourcePlan, handlers.business || {}),
  ]);
  const collectedAt = new Date().toISOString();
  const windowEnd = collectedAt;
  const windowStart = periodKey === 'today'
    ? attention?.since || null
    : new Date(Date.now() - periodDays * 86400000).toISOString();
  const source = (available, overrides = {}) => ({
    status: available ? 'available' : 'unavailable',
    collectedAt,
    windowStart,
    windowEnd,
    timezone: 'Africa/Johannesburg',
    complete: Boolean(available),
    ...overrides,
  });
  return {
    periodDays,
    periodLabel: periodKey === 'today' ? 'Today' : `${periodDays}-day view`,
    attention: {
      available: attention.available,
      source: attention.source || source(false, { reason: 'not_requested', complete: false }),
      totalActiveSeconds: attention.totalActiveSeconds,
      products: attention.products,
      categories: attention.categories,
    },
    orders: {
      source: source(needsOrders && Boolean(orders.summary), { rowCount: Number(orders.summary?.totalOrders) || 0 }),
      summary: orders.summary,
      topProducts: orders.topOrderedProducts,
      topCategories: orders.topOrderedCategories,
    },
    search: {
      source: source(needsSearch && Boolean(search.kpis), { rowCount: Number(search.kpis?.totalSearches) || 0 }),
      kpis: search.kpis,
      zeroResultTerms: search.zeroResultTerms,
    },
    baskets: {
      ...(baskets.summary || {}),
      source: source(needsBaskets && Boolean(baskets.summary), { rowCount: Number(baskets.summary?.basketCount) || 0 }),
    },
    operations: {
      health: needsHealth ? health : undefined,
      images: needsImages ? images : undefined,
    },
    business,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (['GET', 'POST'].includes(req.method) && !isAnalyticsWriteRuntime()) {
    return res.status(409).json({ error: READ_ONLY_PREVIEW_MESSAGE });
  }
  if (!(await requireAdminKey(req, res))) return;
  const admin = await verifyAdminUser(req);
  const requester = admin?.id ? `admin-user:${admin.id}` : 'admin-service';

  if (req.method === 'POST') {
    const limit = await checkRateLimit({ bucket: `codex-analytics:${requester}`, max: 10, windowSeconds: 3600 });
    if (!limit.allowed) return res.status(429).json({ error: 'Codex analysis limit reached. Try again later.' });
    let apolloRequest;
    const role = getAdminRole(admin?.email) || 'owner';
    const approvedSources = new Set(filterApolloSourcesForRole(role).map((source) => source.id));
    try { apolloRequest = normalizeApolloRequest(req.body, approvedSources); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const periodDays = [1, 7, 30, 90].includes(Number(req.body?.periodDays)) ? Number(req.body.periodDays) : 30;
    const periodKey = req.body?.periodKey === 'today' && periodDays === 1 ? 'today' : 'rolling';
    const focus = normalizeAnalyticsFocus(req.body?.focus);
    let sourceSnapshot;
    try {
      sourceSnapshot = previewAnalyticsGatewayEnabled()
        ? await callPreviewAnalyticsGateway('snapshot', { periodDays, periodKey, sourcePlan: apolloRequest.sourcePlan })
        : await buildServerSnapshot(req, periodDays, {}, periodKey, focus, apolloRequest.sourcePlan);
    } catch {
      return res.status(503).json({ error: 'A required Apollo data source is unavailable. No analysis was queued. Please check its connection before trying again.' });
    }
    const prepared = prepareCodexSnapshot(sourceSnapshot);
    const snapshot = focusAnalyticsSnapshot({
      ...prepared.snapshot,
      periodLabel: sourceSnapshot.periodLabel,
      apolloRequest,
    }, focus);
    const { referenceMap } = prepared;
    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({ snapshot, referenceMap }))
      .digest('hex');
    let job;
    if (previewAnalyticsGatewayEnabled()) {
      job = (await callPreviewAnalyticsGateway('enqueue', { snapshot, referenceMap, snapshotHash, requester, apolloRequest })).job;
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
      data = (await callPreviewAnalyticsGateway('status', { jobId: id, requester })).job;
    } else {
      const supabase = db();
      const result = await supabase.from('codex_analytics_jobs')
        .select('id, status, result, reference_map, error, requested_at, started_at, completed_at')
        .eq('id', id)
        .eq('requested_by', requester)
        .maybeSingle();
      if (result.error) return res.status(400).json({ error: result.error.message });
      data = result.data;
    }
    if (!data) return res.status(404).json({ error: 'Analytics job not found.' });
    const { reference_map: referenceMap, requested_by: _requestedBy, ...job } = data;
    if (job.result) job.result = applyCodexReferenceMap(job.result, referenceMap);
    return res.status(200).json(job);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
