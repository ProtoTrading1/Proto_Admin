import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const IMPORT_CHUNK = 500;

function normalizeImportRow(raw) {
  const email = String(raw?.email || raw?.EmailAddress || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const name = String(raw?.companyName || raw?.CompanyName || raw?.name || '').trim();
  const contactName = String(raw?.contactName || raw?.ContactName || '').trim();
  return {
    account_code: String(raw?.account || raw?.Account || raw?.account_code || '').trim().toUpperCase() || null,
    name: name || email,
    contact_name: contactName || null,
    first_name: contactName ? contactName.split(/\s+/)[0] : null,
    email,
    sales_last_12_months: Number(raw?.totalSpend ?? raw?.TotalSpend ?? raw?.sales_last_12_months) || 0,
  };
}

/** Paginated read + inline edit + CSV import of proto active customer allowlist. */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;

  if (req.method === 'POST') {
    const { action, rows, batchLabel, tags } = req.body || {};
    if (action !== 'import') return res.status(400).json({ error: 'action must be import' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' });

    // Every upload is stamped as a group so it can be found and emailed as a
    // unit afterwards. created_at alone could not do this: an upsert on an
    // existing email refreshes the row without moving created_at, so a
    // re-uploaded contact would stay filed under its first import.
    const batchAt = new Date();
    const batch = String(batchLabel || '').trim()
      || `${batchAt.toISOString().slice(0, 16).replace('T', ' ')} import`;
    // Tags arrive as a list or a comma-separated string; normalise, dedupe and
    // cap so one bad paste cannot write hundreds of junk tags onto every row.
    const cleanTags = [...new Set(
      (Array.isArray(tags) ? tags : String(tags || '').split(','))
        .map((t) => String(t || '').trim())
        .filter(Boolean),
    )].slice(0, 20);

    const seen = new Set();
    const cleaned = [];
    let skipped = 0;
    for (const raw of rows) {
      const row = normalizeImportRow(raw);
      if (!row || seen.has(row.email)) {
        skipped += 1;
        continue;
      }
      seen.add(row.email);
      cleaned.push({ ...row, import_batch: batch, import_batch_at: batchAt.toISOString(), tags: cleanTags });
    }
    if (!cleaned.length) return res.status(400).json({ error: 'No valid rows (need EmailAddress on each row)' });

    try {
      const sb = getAdminClient();
      let imported = 0;
      for (let i = 0; i < cleaned.length; i += IMPORT_CHUNK) {
        const chunk = cleaned.slice(i, i + IMPORT_CHUNK);
        const { error } = await sb
          .from('proto_active_customers')
          .upsert(chunk, { onConflict: 'email' });
        if (error) throw error;
        imported += chunk.length;
      }
      return res.status(200).json({ ok: true, imported, skipped, batch, tags: cleanTags });
    } catch (err) {
      console.error('proto-active-customers POST import:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Import failed' });
    }
  }

  if (req.method === 'PATCH') {
    const { id, contact_name, first_name, name, email, account_code, sales_last_12_months, invoice_count, last_purchase_date } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const patch = {};
    if (contact_name !== undefined) patch.contact_name = String(contact_name).trim() || null;
    if (first_name !== undefined) patch.first_name = String(first_name).trim() || null;
    if (name !== undefined) patch.name = String(name).trim() || null;
    if (email !== undefined) {
      const e = String(email).trim().toLowerCase();
      if (!e || !e.includes('@')) return res.status(400).json({ error: 'Valid email required' });
      patch.email = e;
    }
    if (account_code !== undefined) patch.account_code = String(account_code).trim().toUpperCase() || null;
    if (sales_last_12_months !== undefined) patch.sales_last_12_months = Number(sales_last_12_months) || 0;
    if (invoice_count !== undefined) patch.invoice_count = Math.max(0, parseInt(invoice_count, 10) || 0);
    if (last_purchase_date !== undefined) patch.last_purchase_date = last_purchase_date || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });

    try {
      const sb = getAdminClient();
      const { data, error } = await sb
        .from('proto_active_customers')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return res.status(200).json({ ok: true, row: data });
    } catch (err) {
      console.error('proto-active-customers PATCH:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Update failed' });
    }
  }

  if (req.method === 'DELETE') {
    const { id, all, confirm } = req.body || {};
    if (all) {
      if (confirm !== 'DELETE ALL CUSTOMERS') {
        return res.status(400).json({ error: 'confirm must be DELETE ALL CUSTOMERS' });
      }
      try {
        const sb = getAdminClient();
        const { count, error: countError } = await sb
          .from('proto_active_customers')
          .select('*', { count: 'exact', head: true });
        if (countError) throw countError;
        const { error } = await sb.from('proto_active_customers').delete().not('id', 'is', null);
        if (error) throw error;
        return res.status(200).json({ ok: true, deleted: count || 0 });
      } catch (err) {
        console.error('proto-active-customers DELETE all:', err?.message || err);
        return res.status(500).json({ error: err.message || 'Delete all failed' });
      }
    }
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const sb = getAdminClient();
      const { error } = await sb.from('proto_active_customers').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('proto-active-customers DELETE:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Delete failed' });
    }
  }

  if (req.method !== 'GET') return res.status(405).end();

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const search = String(req.query.search || '').trim();
  const batchFilter = String(req.query.batch || '').trim();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    const sb = getAdminClient();
    let q = sb
      .from('proto_active_customers')
      .select('*', { count: 'exact' })
      .order('name', { ascending: true })
      .range(from, to);

    if (batchFilter) q = q.eq('import_batch', batchFilter);

    if (search) {
      const safe = search.replace(/[%',()]/g, ' ').trim();
      if (safe) {
        q = q.or(`email.ilike.%${safe}%,name.ilike.%${safe}%,account_code.ilike.%${safe}%,contact_name.ilike.%${safe}%,first_name.ilike.%${safe}%`);
      }
    }

    const { data, error, count } = await q;
    if (error) {
      if (/proto_active_customers/.test(error.message)) {
        return res.status(200).json({
          rows: [],
          total: 0,
          page,
          pageSize,
          migrationRequired: true,
          message: 'Run migration 021_proto_active_customers.sql, then seed the allowlist.',
        });
      }
      throw error;
    }

    // The batch list drives the group filter. Read separately from the page so
    // it lists every upload, not just the groups present on the current page.
    let batches = [];
    try {
      const { data: batchRows } = await sb
        .from('proto_active_customers')
        .select('import_batch, import_batch_at')
        .not('import_batch', 'is', null)
        .order('import_batch_at', { ascending: false });
      const byLabel = new Map();
      for (const r of batchRows || []) {
        const entry = byLabel.get(r.import_batch);
        if (entry) entry.count += 1;
        else byLabel.set(r.import_batch, { label: r.import_batch, at: r.import_batch_at, count: 1 });
      }
      batches = [...byLabel.values()];
    } catch {
      // The group filter is a convenience — never fail the list over it.
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      rows: data || [],
      total: count || 0,
      batches,
      page,
      pageSize,
    });
  } catch (err) {
    console.error('proto-active-customers:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load proto active customers' });
  }
}
