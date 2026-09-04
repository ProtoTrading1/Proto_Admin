import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { summariseCustomerAttention } from '../lib/customer-attention.mjs';
import { directAnalyticsDataEnabled } from './_analytics-preview-gateway.js';

const RANGES = { today: 1, day: 1, week: 7, month: 30, quarter: 90 };

function johannesburgTodayStartIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+02:00`).toISOString();
}

function client() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function customerRows(supabase, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows = [];
  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await supabase.from('customers')
      .select('id, name, contact_name, business_name, email')
      .in('id', unique.slice(index, index + 200));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!directAnalyticsDataEnabled()) return res.status(409).json({ error: 'Apollo analytics are not connected to an approved isolated data source in this preview.' });
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const range = RANGES[req.query.range] ? String(req.query.range) : 'month';
  const collectedAt = new Date();
  const until = collectedAt.toISOString();
  const since = range === 'today' ? johannesburgTodayStartIso(collectedAt) : new Date(collectedAt.getTime() - RANGES[range] * 86400000).toISOString();
  const supabase = client();
  const { data, error } = await supabase.from('customer_content_attention')
    .select('customer_id, content_type, entity_id, entity_label, active_seconds, started_at, last_seen_at')
    .gte('last_seen_at', since)
    .lte('last_seen_at', until)
    .order('last_seen_at', { ascending: false })
    .limit(10001);

  if (error?.code === '42P01') {
    return res.status(200).json({ available: false, range, since, until, source: { status: 'unavailable', reason: 'table_missing', collectedAt: until, windowStart: since, windowEnd: until, timezone: 'Africa/Johannesburg', complete: false }, ...summariseCustomerAttention([]) });
  }
  if (error) return res.status(200).json({ available: false, range, since, until, source: { status: 'error', reason: 'query_failed', collectedAt: until, windowStart: since, windowEnd: until, timezone: 'Africa/Johannesburg', complete: false }, ...summariseCustomerAttention([]) });

  try {
    const rows = (data || []).slice(0, 10000);
    const truncated = (data || []).length > 10000;
    const customers = await customerRows(supabase, rows.map((row) => row.customer_id));
    return res.status(200).json({
      available: true,
      range,
      since,
      until,
      truncated,
      rowCount: rows.length,
      rowLimit: 10000,
      source: { status: 'available', collectedAt: until, windowStart: since, windowEnd: until, timezone: 'Africa/Johannesburg', complete: !truncated, truncated, rowCount: rows.length, rowLimit: 10000 },
      ...summariseCustomerAttention(rows, customers),
    });
  } catch {
    return res.status(200).json({ available: false, range, since, until, source: { status: 'error', reason: 'customer_lookup_failed', collectedAt: until, windowStart: since, windowEnd: until, timezone: 'Africa/Johannesburg', complete: false }, ...summariseCustomerAttention([]) });
  }
}
