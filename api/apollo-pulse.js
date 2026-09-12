import { verifyAdminUser, isOwnerEmail } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { getPortalAdminClient } from './_site-config.js';
import { reportingWindow, paginateSelect, aggregateWebsiteOrders } from '../lib/apollo-reporting.mjs';
import { summariseBasket, basketActivityMs } from '../lib/abandoned-baskets.mjs';
import { fetchPositillTopSellers } from './_sql-sales.js';
import { readPositillEvidence } from '../lib/apollo-positill-evidence.mjs';
import { readApolloActivity } from '../lib/apollo-activity-reader.mjs';

export const config = { maxDuration: 30 };
const unavailable = (source, reason, window, checkedAt) => ({
  source, status: 'unavailable', complete: false, data: null, reason,
  window, checkedAt, asOf: checkedAt, periodClosed: window ? Date.parse(window.end) <= Date.parse(checkedAt) : null, lastSuccessfulAt: null,
});

async function readSource(source, window, checkedAt, read) {
  try {
    const data = await read();
    return { source, status: 'available', complete: data?.complete !== false, data, window, checkedAt, asOf: checkedAt,
      periodClosed: window ? Date.parse(window.end) <= Date.parse(checkedAt) : null, lastSuccessfulAt: checkedAt };
  } catch {
    // Do not leak database messages or substitute zero for a failed source.
    return unavailable(source, 'Source could not be read completely. Retry or check backend health.', window, checkedAt);
  }
}

function rows(client, table, columns, order, filter = q => q) {
  return paginateSelect({ selectPage: ({ from, to }) => filter(client.from(table).select(columns))
    .order(order, { ascending: true }).range(from, to), maxRows: 20000 });
}

// Activity reporting is intentionally isolated from the portal database.
// It must never fall back to site credentials or browser-visible variables.
export function getApolloActivityClient() {
  const url = String(process.env.APOLLO_ACTIVITY_SUPABASE_URL || '').trim();
  const key = String(process.env.APOLLO_ACTIVITY_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Apollo activity database is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function createPulseHandler({ verify = verifyAdminUser, owner = isOwnerEmail, client = getPortalAdminClient,
  enabled = () => process.env.APOLLO_PULSE_ENABLED === 'true', positillEvidenceEnabled = () => process.env.APOLLO_POSITILL_EVIDENCE_ENABLED === 'true',
  positillFetcher = fetchPositillTopSellers, activityClient = getApolloActivityClient,
  activityReader = readApolloActivity, now = () => new Date() } = {}) {
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
    const periodFilter = q => q.gte('created_at', window.start).lt('created_at', window.end);
    if (req.query?.view === 'live') {
      const source = await readSource('portal.customer_presence + customer_account_carts', null, checkedAt, async () => {
        const presence = await rows(db, 'customer_presence', 'customer_id,last_seen_at', 'customer_id',
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
              basketState: cart ? (basket ? 'recorded' : 'empty') : 'not_recorded', currentSection: null });
          }
        }
        return { count: customers.length, freshnessSeconds: 150, customers, taxBasis: 'incl_vat',
          limitations: ['Current section and active browsing duration are not yet collected reliably. Basket prices are saved snapshots, not a checkout quote.'] };
      });
      return res.status(200).json({ contractVersion: 'apollo-pulse.v1', checkedAt, live: source });
    }
    const [orders, searches] = await Promise.all([
      readSource('portal.orders', window, checkedAt, async () => ({ ...aggregateWebsiteOrders(await rows(db, 'orders',
        'id,status,total_ex_vat,created_at,original_items,final_items,items', 'id', periodFilter)), taxBasis: 'incl_vat',
      label: 'Website order value — not Positill sales', limitations: ['Rankings reflect recorded website orders; POS reconciliation is not yet available.'] })),
      readSource('portal.search_analytics', window, checkedAt, async () => {
        const events = await rows(db, 'search_analytics', 'id,search_term,normalized_search_term,results_found,created_at', 'id', periodFilter);
        const terms = new Map();
        let invalidRecords = 0;
        for (const e of events) {
          const term = String(e.normalized_search_term || e.search_term || '').trim();
          const rawResults = e.results_found;
          const resultsFound = rawResults === null || rawResults === undefined || typeof rawResults === 'boolean' || String(rawResults).trim() === ''
            ? null : Number(rawResults);
          if (!term || !Number.isFinite(resultsFound) || resultsFound < 0) { invalidRecords += 1; continue; }
          const row = terms.get(term) || { term, searches: 0, zeroResults: 0 };
          row.searches += 1;
          row.zeroResults += resultsFound === 0 ? 1 : 0;
          terms.set(term, row);
        }
        return { recordedSearches: events.length, topTerms: [...terms.values()].sort((a, b) => b.searches - a.searches || a.term.localeCompare(b.term)).slice(0, 20),
          complete: invalidRecords === 0, invalidRecords,
          surface: 'legacy_unspecified', limitations: ['Legacy records have no Main/Instore source field. Instore search tracking is not yet connected. This is recorded activity, not proof of complete coverage.'] };
      }),
    ]);
    const positill = await readPositillEvidence({ window, checkedAt, enabled: positillEvidenceEnabled(), fetchTopSellers: positillFetcher });
    const activeTime = await readSource('apollo_activity_events', window, checkedAt, async () => activityReader({
      client: activityClient(), window, checkedAt,
    }));
    return res.status(200).json({ contractVersion: 'apollo-pulse.v1', checkedAt, window, orders, searches,
      positill,
      memory: unavailable('Apollo memory', 'Production memory schema and approved retrieval are not enabled.', null, checkedAt),
      activeTime });
  };
}

export default createPulseHandler();
