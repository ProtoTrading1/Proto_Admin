import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') return res.status(405).end();

  const supabase = getAdminClient();

  const [custRes, ordRes] = await Promise.all([
    supabase.from('customers').select('id, created_at, is_approved'),
    supabase.from('orders').select('id, total_ex_vat, created_at'),
  ]);

  if (custRes.error) return res.status(400).json({ error: custRes.error.message });
  if (ordRes.error) return res.status(400).json({ error: ordRes.error.message });

  const customers = custRes.data || [];
  const orders = ordRes.data || [];
  const approved = customers.filter((c) => c.is_approved);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const totalRevenue = orders.reduce((s, o) => s + (o.total_ex_vat || 0), 0);

  return res.status(200).json({
    totalCustomers: approved.length,
    newSignups30d: approved.filter((c) => new Date(c.created_at) > cutoff).length,
    totalOrders: orders.length,
    totalRevenue,
    avgOrderSize: orders.length ? totalRevenue / orders.length : 0,
  });
}
