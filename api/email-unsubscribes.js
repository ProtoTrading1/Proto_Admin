import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { listBrevoSuppressedContacts, suppressBrevoContact } from './_brevo-suppression.js';

const PAGE_SIZE_MAX = 200;

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function fetchPortalCustomers(sb) {
  const rows = [];
  const batchSize = 1000;
  for (let from = 0; ; from += batchSize) {
    const { data, error } = await sb
      .from('customers')
      .select('email, name, contact_name, first_name, business_name')
      .range(from, from + batchSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < batchSize) break;
  }
  return rows;
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
      await suppressBrevoContact(email, { createIfMissing: true });
      const sb = getPortalDbClient();
      const { data: existing, error: lookupError } = await sb
        .from('marketing_email_opt_outs')
        .select('email')
        .eq('email', email)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) return res.status(200).json({ email, existing: true });

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
  try {
    const sb = getPortalDbClient();
    const [localResult, brevoRows, customers] = await Promise.all([
      sb
      .from('marketing_email_opt_outs')
      .select('email, source, unsubscribed_at, created_at'),
      listBrevoSuppressedContacts(),
      fetchPortalCustomers(sb),
    ]);
    if (localResult.error) throw localResult.error;

    const customersByEmail = new Map(customers.map((customer) => [String(customer.email || '').trim().toLowerCase(), customer]));
    const rowsByEmail = new Map();
    for (const row of brevoRows) rowsByEmail.set(row.email, row);
    for (const row of localResult.data || []) {
      const email = String(row.email || '').trim().toLowerCase();
      if (!email) continue;
      rowsByEmail.set(email, { ...rowsByEmail.get(email), ...row, email });
    }
    const merged = [...rowsByEmail.values()].map((row) => {
      const customer = customersByEmail.get(row.email) || {};
      return {
        ...row,
        business_name: customer.business_name || row.business_name || customer.name || '',
        contact_name: customer.contact_name || customer.first_name || row.contact_name || customer.name || '',
      };
    }).filter((row) => !search || [row.email, row.business_name, row.contact_name]
      .some((value) => String(value || '').toLowerCase().includes(search)))
      .sort((a, b) => String(b.unsubscribed_at || b.created_at || '').localeCompare(String(a.unsubscribed_at || a.created_at || '')));
    const from = (page - 1) * pageSize;
    const rows = merged.slice(from, from + pageSize);

    return res.status(200).json({
      rows,
      total: merged.length,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('email-unsubscribes:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load unsubscribed contacts' });
  }
}


