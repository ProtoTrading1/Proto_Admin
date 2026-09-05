import { requireAdminKey, requireCronOrAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { readSiteConfigJson } from './_site-config.js';

const CAMPAIGN_META_FILE = 'crm/brevo-campaign-summary.json';

function getMainClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Paginated read from background-synced crm_contacts — never calls Brevo live. */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') return res.status(405).end();

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const search = String(req.query.search || '').trim();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    const sb = getMainClient();
    let q = sb
      .from('crm_contacts')
      .select('*', { count: 'exact' })
      .order('synced_at', { ascending: false })
      .range(from, to);

    if (search) {
      const safe = search.replace(/[%',()]/g, ' ').trim();
      if (safe) q = q.or(`email.ilike.%${safe}%,name.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) {
      if (/crm_contacts/.test(error.message)) {
        return res.status(200).json({
          rows: [],
          total: 0,
          page,
          pageSize,
          syncRequired: true,
          message: 'Run migration 020_crm_contacts.sql on the portal Supabase project.',
        });
      }
      throw error;
    }

    const { data: meta } = await sb
      .from('crm_contacts')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const campaignMeta = await readSiteConfigJson(CAMPAIGN_META_FILE, null);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({
      rows: data || [],
      total: count || 0,
      page,
      pageSize,
      lastSyncedAt: meta?.synced_at || null,
      lastCampaignName: campaignMeta?.name || null,
      campaign: campaignMeta,
    });
  } catch (err) {
    console.error('crm-contacts:', err?.message || err);
    return res.status(500).json({ error: err.message || 'CRM fetch failed' });
  }
}
