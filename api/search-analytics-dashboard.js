import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

const VALID_PERIODS = [7, 30, 90, 0];
const TOP_N = 10;

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function parsePeriod(raw) {
  const n = parseInt(raw, 10);
  return VALID_PERIODS.includes(n) ? n : 30;
}

function startDateFromPeriod(periodDays) {
  if (!periodDays) return null;
  const d = new Date();
  d.setDate(d.getDate() - periodDays);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function withStart(q, startDate) {
  return startDate ? q.gte('created_at', startDate) : q;
}

function firstError(results) {
  for (const r of results) {
    if (r?.error) return r.error;
  }
  return null;
}

async function loadDashboard(supabase, startDate) {
  const [
    totalRes,
    withResultsRes,
    noResultsRes,
    ordersRes,
    revenueRes,
    funnelClicksRes,
    funnelCartRes,
    latestRes,
    volumeRes,
    topRes,
    zeroRes,
    ordersTermsRes,
    zeroOrderRes,
  ] = await Promise.all([
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ),
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ).gt('results_found', 0),
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ).eq('results_found', 0),
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ).eq('order_created', true),
    withStart(
      supabase.from('search_analytics').select('order_value'),
      startDate,
    ).eq('order_created', true),
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ).not('search_position_clicked', 'is', null),
    withStart(
      supabase.from('search_analytics').select('id', { count: 'exact', head: true }),
      startDate,
    ).eq('added_to_cart', true),
    supabase
      .from('search_analytics')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.rpc('rpc_search_volume_by_day', { p_start: startDate }),
    supabase.rpc('rpc_top_searches', { p_start: startDate, p_limit: TOP_N }),
    supabase.rpc('rpc_zero_result_terms', { p_start: startDate, p_limit: TOP_N }),
    supabase.rpc('rpc_searches_to_orders', { p_start: startDate, p_limit: TOP_N }),
    supabase.rpc('rpc_zero_order_terms', { p_start: startDate, p_limit: TOP_N }),
  ]);

  const tableError = firstError([
    totalRes, withResultsRes, noResultsRes, ordersRes, revenueRes,
    funnelClicksRes, funnelCartRes, latestRes,
    volumeRes, topRes, zeroRes, ordersTermsRes, zeroOrderRes,
  ]);

  const trackingEnabled = !tableError || tableError.code !== '42P01';
  const totalSearches = totalRes.count || 0;
  const searchesWithResults = withResultsRes.count || 0;
  const searchesNoResults = noResultsRes.count || 0;
  const searchesToOrders = ordersRes.count || 0;
  const conversionPct = totalSearches
    ? Number(((searchesToOrders / totalSearches) * 100).toFixed(1))
    : 0;
  const revenue = (revenueRes.data || []).reduce((sum, r) => sum + Number(r.order_value || 0), 0);

  const volumeByDay = (volumeRes.data || [])
    .slice(-TOP_N)
    .map((row) => ({
      date: row.day,
      label: new Date(row.day).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
      searches: Number(row.search_count),
    }));

  return {
    meta: {
      trackingEnabled,
      lastSearchAt: latestRes.data?.created_at || null,
      tableError: tableError ? tableError.message : null,
    },
    kpis: {
      totalSearches,
      searchesWithResults,
      searchesNoResults,
      searchesToOrders,
      conversionPct,
      revenue,
    },
    funnel: {
      total: totalSearches,
      clicks: funnelClicksRes.count || 0,
      cart: funnelCartRes.count || 0,
      orders: searchesToOrders,
    },
    volumeByDay,
    topSearches: topRes.data || [],
    zeroResultTerms: zeroRes.data || [],
    searchesToOrders: ordersTermsRes.data || [],
    zeroOrderTerms: zeroOrderRes.data || [],
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!(await requireAdminKey(req, res))) return;

    if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Supabase env not configured on this deployment' });
    }

    const period = parsePeriod(req.query?.period);
    const startDate = startDateFromPeriod(period);
    const supabase = getAdminClient();

    try {
      const data = await loadDashboard(supabase, startDate);
      if (data.meta.tableError && !data.meta.trackingEnabled) {
        return res.status(503).json({ error: 'Search analytics tables not found — run migration 019 on the main Supabase project.' });
      }
      return res.status(200).json({ period, ...data });
    } catch (err) {
      console.error('search-analytics-dashboard GET:', err?.message || err);
      return res.status(500).json({ error: 'Failed to load search analytics' });
    }
  }

  if (req.method === 'DELETE') {
    if (!(await requireAdminKey(req, res))) return;
    const supabase = getAdminClient();
    const { error } = await supabase.from('search_analytics').delete().gte('created_at', '1970-01-01');
    if (error && !/does not exist/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
