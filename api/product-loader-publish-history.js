import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { auditOutcomeFromRow, logProductLoaderAudit } from './_product-loader-audit.js';

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function mapHistoryRow(row) {
  const nv = row.new_values || {};
  return {
    id: row.id,
    date: row.published_at,
    user: row.published_by || '—',
    sku: row.sku,
    filename: nv.filename || '',
    action: auditOutcomeFromRow(row),
    publishAction: row.action,
    imageSlot: row.image_slot,
    imageSource: row.image_source,
    reason: nv.reason || nv.error || '',
    source: row.source,
    details: nv,
  };
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const sb = getStockClient();

  if (req.method === 'GET') {
    const {
      sku = '',
      q = '',
      action = '',
      limit = '50',
      offset = '0',
    } = req.query || {};

    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = Math.max(0, Number(offset) || 0);

    try {
      let query = sb
        .from('product_publish_audit')
        .select('*', { count: 'exact' })
        .order('published_at', { ascending: false })
        .range(skip, skip + take - 1);

      const cleanSku = String(sku || '').trim().toUpperCase();
      if (cleanSku) query = query.eq('sku', cleanSku);

      const { data, error, count } = await query;
      if (error) throw error;

      let rows = (data || []).map(mapHistoryRow);
      const filterAction = String(action || '').trim().toLowerCase();
      if (filterAction) {
        rows = rows.filter((r) => r.action === filterAction);
      }
      const needle = String(q || '').trim().toLowerCase();
      if (needle) {
        rows = rows.filter((r) => (
          r.sku.toLowerCase().includes(needle)
          || r.filename.toLowerCase().includes(needle)
          || r.reason.toLowerCase().includes(needle)
        ));
      }

      return res.status(200).json({ rows, total: count ?? rows.length });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to load publish history' });
    }
  }

  if (req.method === 'POST') {
    const {
      sku,
      filename,
      outcome = 'failed',
      reason = '',
      publishedBy,
      imageSlot,
    } = req.body || {};

    const cleanSku = String(sku || '').trim().toUpperCase();
    if (!cleanSku) return res.status(400).json({ error: 'sku is required' });

    try {
      await logProductLoaderAudit(sb, {
        sku: cleanSku,
        action: 'update',
        source: 'manual_product_loader',
        publishMode: outcome,
        imageSlot,
        newValues: {
          outcome,
          filename: String(filename || ''),
          reason: String(reason || ''),
        },
        publishedBy,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to log history' });
    }
  }

  return res.status(405).end();
}
