import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { summariseCustomerAttention } from '../lib/customer-attention.mjs';

const RANGES = { day: 1, week: 7, month: 30, quarter: 90 };

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
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const range = RANGES[req.query.range] ? String(req.query.range) : 'month';
  const since = new Date(Date.now() - RANGES[range] * 86400000).toISOString();
  const supabase = client();
  const { data, error } = await supabase.from('customer_content_attention')
    .select('customer_id, content_type, entity_id, entity_label, active_seconds, started_at, last_seen_at')
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(10000);

  if (error?.code === '42P01') {
    return res.status(200).json({ available: false, range, since, ...summariseCustomerAttention([]) });
  }
  if (error) return res.status(400).json({ error: error.message });

  try {
    const customers = await customerRows(supabase, (data || []).map((row) => row.customer_id));
    return res.status(200).json({
      available: true,
      range,
      since,
      truncated: (data || []).length >= 10000,
      ...summariseCustomerAttention(data || [], customers),
    });
  } catch (customerError) {
    return res.status(400).json({ error: customerError.message || 'Customer attention could not be loaded' });
  }
}
