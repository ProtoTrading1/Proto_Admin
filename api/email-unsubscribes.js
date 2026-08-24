import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';

const PAGE_SIZE_MAX = 200;

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST') {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    try {
      const sb = getPortalDbClient();
      const { data: existing, error: lookupError } = await sb
        .from('marketing_email_opt_outs')
        .select('email')
        .eq('email', email)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) return res.status(409).json({ error: 'That email is already unsubscribed' });

      const { error } = await sb.from('marketing_email_opt_outs').insert({
        email,
        source: 'manual_admin',
        unsubscribed_at: new Date().toISOString(),
      });
      if (error) throw error;

      return res.status(201).json({ email });
    } catch (err) {
      console.error('email-unsubscribes:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to add unsubscribed email' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(String(req.query.pageSize || '50'), 10) || 50));
  const search = String(req.query.search || '').trim().toLowerCase();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    const sb = getPortalDbClient();
    let query = sb
      .from('marketing_email_opt_outs')
      .select('email, source, unsubscribed_at, created_at', { count: 'exact' })
      .order('unsubscribed_at', { ascending: false })
      .range(from, to);

    if (search) query = query.ilike('email', `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    return res.status(200).json({
      rows: data || [],
      total: count || 0,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('email-unsubscribes:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load unsubscribed contacts' });
  }
}


