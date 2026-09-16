import { verifyAdminUser, isOwnerEmail } from './_admin-auth.js';
import { getPortalAdminClient } from './_site-config.js';
import { createClient } from '@supabase/supabase-js';
import { reportingWindow, previousReportingWindow, paginateSelect, aggregateWebsiteOrders } from '../lib/apollo-reporting.mjs';
import { buildApolloInsights } from '../lib/apollo-insights.mjs';
import { summariseBasket, basketActivityMs } from '../lib/abandoned-baskets.mjs';
import { readApolloActivity } from '../lib/apollo-activity-reader.mjs';
import { readApolloSearchFunnels } from '../lib/apollo-search-reader.mjs';
import { fetchPositillTopSellers } from './_sql-sales.js';
import { readPositillEvidence } from '../lib/apollo-positill-evidence.mjs';

export const config = { maxDuration: 30 };
const unavailable = (source, reason, window, checkedAt) => ({
  source, status: 'unavailable', complete: false, data: null, reason,
  window, checkedAt, asOf: checkedAt, periodClosed: window ? (!window.periodToDate && Date.parse(window.end) <= Date.parse(checkedAt)) : null, lastSuccessfulAt: null,
});

async function readSource(source, window, checkedAt, read) {
  try {
    const data = await read();
    const complete = data?.complete !== false;
    return { source, status: complete ? 'available' : 'partial', complete, data, window, checkedAt, asOf: checkedAt,
      periodClosed: window ? (!window.periodToDate && Date.parse(window.end) <= Date.parse(checkedAt)) : null, lastSuccessfulAt: checkedAt };
  } catch {
    // Do not leak database messages or substitute zero for a failed source.
    return unavailable(source, 'Source could not be read completely. Retry or check backend health.', window, checkedAt);
  }
}

function rows(client, table, columns, order, filter = q => q) {
  return paginateSelect({ selectPage: ({ from, to }) => filter(client.from(table).select(columns))
    .order(order, { ascending: true }).range(from, to), maxRows: 20000 });
}

async function presenceRows(client, filter) {
  try {
    return await rows(client, 'customer_presence', 'customer_id,last_seen_at,current_section', 'customer_id', filter);
  } catch (error) {
    const message = String(error?.message || '');
    // Deploys should apply the additive migration first, but keep older portal
    // schemas readable during the compatibility window.
    if (!/current_section/i.test(message) || !/(column|schema cache|does not exist|not find)/i.test(message)) throw error;
    return (await rows(client, 'customer_presence', 'customer_id,last_seen_at', 'customer_id', filter))
      .map(row => ({ ...row, current_section: null }));
  }
}

function metricChange(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined ||
      !Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) return { status: 'unavailable' };
  const currentValue = Number(current); const previousValue = Number(previous);
  const delta = Math.round((currentValue - previousValue) * 100) / 100;
  return { status: 'available', current: currentValue, previous: previousValue, delta,
    percentChange: previousValue === 0 ? null : Math.round((delta / Math.abs(previousValue)) * 1000) / 10 };
}

function compareSource(current, previous, previousWindow, fields) {
  if (current?.status !== 'available' || current.complete !== true || previous?.status !== 'available' || previous.complete !== true) {
    return { status: 'unavailable', window: previousWindow, reason: 'A complete result is not available for both periods.' };
  }
  const metrics = Object.fromEntries(fields.map(([key, select]) => [key, metricChange(select(current.data), select(previous.data))]));
  if (Object.values(metrics).some(metric => metric.status !== 'available')) {
    return { status: 'unavailable', window: previousWindow, reason: 'A required metric is not known for both periods.' };
  }
  return { status: 'available', window: previousWindow, metrics };
}

// Activity is intentionally isolated from portal Analytics and has no portal
// database fallback. The same server-only credentials are used by the
// retention endpoint; owner access is checked before this client is created.
export function getApolloActivityReportingClient() {
  const url = String(process.env.APOLLO_ACTIVITY_SUPABASE_URL || '').trim();
  const key = String(process.env.APOLLO_ACTIVITY_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Apollo activity database is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function readBasketRisk({ db, checkedAt }) {
  const carts = await rows(db, 'customer_account_carts', 'customer_id,items,activity_at,updated_at', 'customer_id');
  const checkedMs = Date.parse(checkedAt);
  let openBaskets = 0;
  let totalUnits = 0;
  let valueInclVat = 0;
  let coldBaskets = 0;
  for (const cart of carts) {
    const basket = summariseBasket(cart);
    if (!basket) continue;
    openBaskets += 1;
    totalUnits += basket.totalQty;
    valueInclVat += basket.value;
    const activityAt = basketActivityMs(cart);
    if (Number.isFinite(activityAt) && Number.isFinite(checkedMs) && checkedMs - activityAt > 30 * 86400000) coldBaskets += 1;
  }
  return {
    source: 'portal.customer_account_carts',
    complete: true,
    openBaskets,
    totalUnits,
    valueInclVat: Math.round(valueInclVat * 100) / 100,
    coldBaskets,
    taxBasis: 'incl_vat',
    limitations: ['A saved basket is not a completed sale. Values are saved price snapshots, not a checkout quote.'],
  };
}

export function createPulseHandler({ verify = verifyAdminUser, owner = isOwnerEmail, client = getPortalAdminClient,
  enabled = () => process.env.APOLLO_PULSE_ENABLED === 'true', positillEvidenceEnabled = () => process.env.APOLLO_POSITILL_EVIDENCE_ENABLED === 'true',
  positillBridgeReady = () => Boolean(String(process.env.STOCK_SQL_BRIDGE_URL || '').trim() && String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim()),
  activityEnabled = () => process.env.APOLLO_ACTIVITY_REPORTING_ENABLED === 'true',
  activityClient = getApolloActivityReportingClient, activityReader = readApolloActivity,
  positillFetcher = fetchPositillTopSellers, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Read-only endpoint' });
    const user = await verify(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!owner(user.email)) return res.status(403).json({ error: 'Owner access required' });
    if (!enabled()) return res.status(404).json({ error: 'Apollo Business Pulse is not enabled' });
    const checkedAt = now().toISOString();
    let window;
    try {
      window = reportingWindow(req.query?.period || 'day', { now: checkedAt, start: req.query?.start, end: req.query?.end });
      if (Date.parse(window.end) - Date.parse(window.start) > 366 * 86400000) throw new Error('range');
      if (!['summary', 'live'].includes(req.query?.view || 'summary')) throw new Error('view');
    } catch { return res.status(400).json({ error: 'Choose day, week, month or a valid custom range of up to 366 days.' }); }
    let db;
    try { db = client(); } catch { return res.status(503).json({ error: 'Reporting connection unavailable' }); }
    const previousWindow = previousReportingWindow(window);
    const windowFilter = target => q => q.gte('created_at', target.start).lt('created_at', target.end);
    if (req.query?.view === 'live') {
      const source = await readSource('portal.customer_presence + customer_account_carts', null, checkedAt, async () => {
        const presence = await presenceRows(db,
          q => q.gte('last_seen_at', new Date(Date.parse(checkedAt) - 150000).toISOString()).lte('last_seen_at', checkedAt));
        const customers = [];
        for (let offset = 0; offset < presence.length; offset += 100) {
          const batch = presence.slice(offset, offset + 100);
          const ids = batch.map(p => p.customer_id);
          const [names, carts] = await Promise.all([
            rows(db, 'customers', 'id,name,business_name', 'id', q => q.in('id', ids)),
            rows(db, 'customer_account_carts', 'customer_id,items,activity_at,updated_at', 'customer_id', q => q.in('customer_id', ids)),
          ]);
          for (const p of batch) {
            const person = names.find(n => n.id === p.customer_id);
            const cart = carts.find(c => c.customer_id === p.customer_id);
            const basket = cart ? summariseBasket(cart) : null;
            customers.push({ customerId: p.customer_id, name: person?.business_name || person?.name || 'Customer',
              lastSeenAt: p.last_seen_at, basket, basketActivityAt: cart ? basketActivityMs(cart) : null,
              basketState: cart ? (basket ? 'recorded' : 'empty') : 'not_recorded', currentSection: p.current_section || null });
          }
        }
        return { count: customers.length, freshnessSeconds: 150, customers, taxBasis: 'incl_vat',
          limitations: ['Active browsing duration is not yet available as a live per-customer value. Current section is a coarse heartbeat snapshot and is null until collected. Basket prices are saved snapshots, not a checkout quote.'] };
      });
      return res.status(200).json({ contractVersion: 'apollo-pulse.v1', checkedAt, live: source });
    }
    const readWebsiteOrders = target => readSource('portal.orders', target, checkedAt, async () => ({ ...aggregateWebsiteOrders(await rows(db, 'orders',
      'id,status,total_ex_vat,discount_amount,created_at,original_items,final_items,items', 'id', windowFilter(target))), taxBasis: 'incl_vat',
    label: 'Website order value — not Positill sales', limitations: ['Rankings reflect recorded website orders; POS reconciliation is not yet available.'] }));
    const readLegacySearches = target => readSource('portal.search_analytics', target, checkedAt, async () => {
        const events = await rows(db, 'search_analytics', 'id,search_term,normalized_search_term,results_found,search_position_clicked,added_to_cart,order_created,order_value,created_at', 'id', windowFilter(target));
        const terms = new Map();
        let invalidRecords = 0;
        let zeroResultSearches = 0;
        for (const e of events) {
          const term = String(e.normalized_search_term || e.search_term || '').trim();
          const rawResults = e.results_found;
          const resultsFound = rawResults === null || rawResults === undefined || typeof rawResults === 'boolean' || String(rawResults).trim() === ''
            ? null : Number(rawResults);
          if (!term || !Number.isFinite(resultsFound) || resultsFound < 0) { invalidRecords += 1; continue; }
          const row = terms.get(term) || { term, searches: 0, zeroResults: 0, clicks: 0, cartAdds: 0, orders: 0, orderValue: 0 };
          row.searches += 1;
          row.zeroResults += resultsFound === 0 ? 1 : 0;
          zeroResultSearches += resultsFound === 0 ? 1 : 0;
          row.clicks += e.search_position_clicked == null ? 0 : 1;
          row.cartAdds += e.added_to_cart === true ? 1 : 0;
          row.orders += e.order_created === true ? 1 : 0;
          row.orderValue += e.order_created === true && Number.isFinite(Number(e.order_value)) ? Number(e.order_value) : 0;
          terms.set(term, row);
        }
        const termRows = [...terms.values()].sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term));
        return { recordedSearches: events.length,
          zeroResultSearches,
          clicks: termRows.reduce((sum, row) => sum + row.clicks, 0),
          cartAdds: termRows.reduce((sum, row) => sum + row.cartAdds, 0),
          attributedOrders: termRows.reduce((sum, row) => sum + row.orders, 0),
          attributedOrderValue: termRows.reduce((sum, row) => sum + row.orderValue, 0),
          topTerms: termRows.slice(0, 20),
          complete: invalidRecords === 0, invalidRecords,
          surface: 'legacy_unspecified', limitations: ['Legacy records have no Main/Instore source field. Instore search tracking is not yet connected. This is recorded activity, not proof of complete coverage.'] };
      });
    const [orders, searches, priorOrders, priorSearches] = await Promise.all([
      readWebsiteOrders(window), readLegacySearches(window),
      readWebsiteOrders(previousWindow), readLegacySearches(previousWindow),
    ]);
    if (orders.data) orders.data.comparison = compareSource(orders, priorOrders, previousWindow, [
      ['orderCount', data => data.orders], ['revenue', data => data.revenue],
    ]);
    if (searches.data) searches.data.comparison = compareSource(searches, priorSearches, previousWindow, [
      ['searches', data => data.recordedSearches], ['zeroResultSearches', data => data.zeroResultSearches],
    ]);
    // Apollo must use the existing authenticated bridge only. The legacy
    // fetcher can also fall back to direct SQL; never let Apollo take that path.
    const positill = await readPositillEvidence({ window, checkedAt,
      enabled: positillEvidenceEnabled() && positillBridgeReady(), fetchTopSellers: positillFetcher });
    const activityCollectionEnabled = activityEnabled();
    let activityDb = null;
    if (activityCollectionEnabled) { try { activityDb = activityClient(); } catch { /* reported as unavailable below */ } }
    const [activeTime, baskets] = await Promise.all([
      activityCollectionEnabled
        ? readSource('apollo_activity_events', window, checkedAt, async () => {
          if (!activityDb) throw new Error('Apollo activity database is not configured');
          return activityReader({ client: activityDb, window, checkedAt });
        })
        : Promise.resolve(unavailable('apollo_activity_events', 'Activity reporting is disabled until collection coverage is verified.', window, checkedAt)),
      readSource('portal.customer_account_carts', null, checkedAt, async () => readBasketRisk({ db, checkedAt })),
    ]);
    const searchActivity = activityCollectionEnabled
      ? await readSource('apollo_activity_events', window, checkedAt, async () => {
        if (!activityDb) throw new Error('Apollo activity database is not configured');
        return readApolloSearchFunnels({ client: activityDb, window, sources: activeTime.data?.sources || {} });
      })
      : unavailable('apollo_activity_events', 'Source-separated search reporting is disabled until collection coverage is verified.', window, checkedAt);
    const insights = buildApolloInsights({ orders, searches, activity: activeTime, baskets });
    return res.status(200).json({ contractVersion: 'apollo-pulse.v1', checkedAt, window, orders, searches, searchActivity, insights,
      positill, baskets,
      memory: unavailable('Apollo memory', 'Production memory schema and approved retrieval are not enabled.', null, checkedAt),
      activeTime });
  };
}

export default createPulseHandler();

