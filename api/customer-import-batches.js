import { requireAdminKey } from './_admin-auth.js';
import { getPortalAdminClient } from './_site-config.js';

/**
 * Pre-registration upload groups, for the email composer's audience list.
 *
 * Deliberately separate from api/proto-active-customers.js, which is guarded by
 * requireOwner. Reading the list of upload groups is not an owner-level action,
 * and gating it that way meant a non-owner admin got a 403 and an audience
 * dropdown that silently offered no groups.
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const sb = getPortalAdminClient();
    const { data, error } = await sb
      .from('proto_active_customers')
      .select('import_batch, import_batch_at')
      .not('import_batch', 'is', null)
      .order('import_batch_at', { ascending: false });
    if (error) throw error;

    const byLabel = new Map();
    for (const row of data || []) {
      const entry = byLabel.get(row.import_batch);
      if (entry) entry.count += 1;
      else byLabel.set(row.import_batch, { label: row.import_batch, at: row.import_batch_at, count: 1 });
    }
    return res.status(200).json({ batches: [...byLabel.values()] });
  } catch (err) {
    console.error('customer-import-batches:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to load upload groups' });
  }
}
