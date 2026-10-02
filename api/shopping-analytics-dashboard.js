import { createClient } from '@supabase/supabase-js';
import { CURRENT_ADMIN_EMAILS, requireAnalyticsAdmin } from './_analytics-auth.js';
import { buildShoppingAnalytics, buildShoppingComparison, buildShoppingEvidence } from '../lib/shopping-analytics.mjs';
import { SOURCE_DEFINITIONS, parseAnalyticsScope, previousAnalyticsScope, readAnalyticsSource, readTrackingStart, readTrackingHealth } from '../lib/analytics-source-reader.mjs';
import {readHistoricalAggregate,buildHistoricalSearchFallback,applyHistoricalCoverage} from '../lib/historical-analytics.mjs';

export const config = { maxDuration: 60 };
export function createShoppingDashboardHandler({
  requireAdmin = requireAnalyticsAdmin, clientFactory = createClient,
  readSource = readAnalyticsSource, readStart = readTrackingStart, aggregate = buildShoppingAnalytics,
  readHistory = readHistoricalAggregate, readHealth = readTrackingHealth,
  environment = process.env, now = () => new Date(),
} = {}) {
return async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let scope;
  try { scope = parseAnalyticsScope(req.query, now()); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const client = clientFactory(environment.VITE_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } });
    const excludedCustomerIds = [...new Set([
      ...String(environment.ANALYTICS_EXCLUDED_CUSTOMER_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
      ...(typeof admin.id === 'string' ? [admin.id] : []),
    ])];
    const aggregationScope = { ...scope, overview: !scope.customerId, excludedCustomerIds, excludedCustomerEmails: [...CURRENT_ADMIN_EMAILS] };
    if (scope.customerSearch) {
      const pattern = `%${scope.customerSearch.replace(/[\\%_]/g, character => `\\${character}`)}%`;
      const matches = await Promise.all(['name', 'business_name'].map(column => client.from('customers')
        .select(SOURCE_DEFINITIONS.customers.columns).ilike(column, pattern).order('id', { ascending: true }).limit(50)));
      if (matches.some(result => result.error)) throw new Error('Customer lookup unavailable');
      const rows = [...new Map(matches.flatMap(result => result.data || []).map(row => [row.id, row])).values()];
      const shaped = aggregate({ customers: rows }, aggregationScope);
      const customerMatches = shaped.customers.map(({ timeline, timelineTruncated, recommendations, ...customer }) => ({ ...customer,
        counts: { visits: null, searches: null, productViews: null, basketAdds: null, orders: null }, detailsAvailable: true }));
      return res.status(200).json({ customerMatches, lookup: { returned: customerMatches.length, limited: matches.some(result => result.data?.length === 50), maximumReturned: 100 }, scope });
    }
    const overview=!scope.customerId && !scope.evidenceType;
    const history=overview ? await readHistory(client,aggregationScope) : null;
    const legacyKeys=['visits','searches','journeys','legacyEvents'];
    const definitions = scope.evidenceType ? Object.entries(SOURCE_DEFINITIONS).filter(([name]) => ['events','customers','products'].includes(name)) : Object.entries(SOURCE_DEFINITIONS).filter(([name])=>!history?.available || !legacyKeys.includes(name));
    const results = await Promise.all(definitions.map(async ([name, definition]) => {
      return [name, await readSource(client, definition, scope,overview && legacyKeys.includes(name) ? {maxRows:5000} : undefined)];
    }));
    const input = { statuses: {} };
    for (const [name, result] of results) { input[name] = result.rows; input.statuses[name] = result.status; }
    if (scope.evidenceType) return res.status(200).json({ evidence: buildShoppingEvidence(input, aggregationScope), scope, refreshedAt: now().toISOString() });
    const data = aggregate(input, aggregationScope);
    const historicalSearch=overview ? history?.available ? history.historicalSearch : buildHistoricalSearchFallback(input,aggregationScope,data) : undefined;
    if (history?.available) { data.historicalSummary=history.historicalSummary;applyHistoricalCoverage(data,history); }
    let comparison;
    let trackingStart;
    let trackingHealth;
    if (!scope.customerId) {
      const previousScope = previousAnalyticsScope(aggregationScope);
      const previousInput = { customers: input.customers, products: input.products, statuses: { customers: input.statuses.customers, products: input.statuses.products } };
      await Promise.all([...['events', 'orders'].map(async name => {
        const result = await readSource(client, SOURCE_DEFINITIONS[name], previousScope);
        previousInput[name] = result.rows; previousInput.statuses[name] = result.status;
      }), (async () => { trackingStart = await readStart(client); })(), (async()=>{trackingHealth=await readHealth(client);})()]);
      comparison = buildShoppingComparison(input, previousInput, aggregationScope, previousScope, data);
    }
    if (scope.customerId) {
      const customer = data.customers.find(row => row.id === scope.customerId);
      if (!customer) return res.status(404).json({ error: 'No customer details are available for this scope.' });
      const eventsAvailable = data.quality.sources.events.available;
      const counts = Object.fromEntries(Object.entries(customer.counts).map(([key,value]) => [key,
        !eventsAvailable || (key === 'orders' && !data.quality.sources.orders.available) ? null : value]));
      return res.status(200).json({ customer: { ...customer, counts, dataCoverage: data.quality.sources.events }, quality: data.quality, scope, refreshedAt: now().toISOString() });
    }
    // Timelines and recommendations are fetched only when a customer is
    // selected. Bound ranked lists without changing any aggregate totals.
    const limits = { customers: 200, terms: 100, products: 100, departments: 100, actions: 20 };
    const responseLimits = {};
    const bounded = {};
    for (const [key, limit] of Object.entries(limits)) {
      bounded[key] = data[key].slice(0, limit);
      responseLimits[key] = { total: data[key].length, returned: bounded[key].length, truncated: data[key].length > limit };
    }
    bounded.customers = bounded.customers.map(({ timeline, timelineTruncated, recommendations, ...customer }) => ({ ...customer, detailsAvailable: true }));
    return res.status(200).json({ summary: data.summary, trend: data.trend, funnel: data.funnel, popup: data.popup,
      definitions: data.definitions, comparison, trackingStart, trackingHealth, historicalSearch, historicalSummary: data.historicalSummary,
      ...bounded, quality: { ...data.quality, responseLimits }, scope, refreshedAt: now().toISOString() });
  } catch {
    // No raw database errors, customer records or identifiers in server logs.
    return res.status(503).json({ error: 'Analytics could not be refreshed. Try again shortly.' });
  }
};
}
export default createShoppingDashboardHandler();
