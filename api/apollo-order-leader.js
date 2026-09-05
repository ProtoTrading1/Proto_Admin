import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { publicBuyerRanking, rollingWindow, weekToDateWindow } from '../lib/customer-purchase-ranking.mjs';
import { directAnalyticsDataEnabled } from './_analytics-preview-gateway.js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function requestedWindow(query = {}, now = new Date()) {
  return String(query.window || '').toLowerCase() === 'week_to_date'
    ? weekToDateWindow(now)
    : rollingWindow(query.period, now);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!directAnalyticsDataEnabled()) return res.status(409).json({ error: 'Apollo analytics are not connected to an approved isolated data source in this preview.' });
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const window = requestedWindow(req.query);
  const { data, error } = await getAdminClient()
    .from('orders')
    .select('customer_id, status, total_ex_vat, original_items, final_items, items, customers(name, business_name)')
    .gte('created_at', window.from)
    .lte('created_at', window.to);
  if (error) return res.status(400).json({ error: 'Apollo could not read the authenticated online-order ranking.' });

  return res.status(200).json(publicBuyerRanking(data || [], window));
}
