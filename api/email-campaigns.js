import { requireAdminKey } from './_admin-auth.js';
import { readEmailCampaigns } from './_email-campaigns.js';
import { getPortalAdminClient } from './_site-config.js';
import { buildCampaignApprovalReport } from '../lib/campaign-approval-attribution.mjs';

const CUSTOMER_PAGE_SIZE = 1000;

async function fetchApprovedCustomers() {
  const supabase = getPortalAdminClient();
  const rows = [];
  let from = 0;
  let useApprovalColumns = true;

  for (;;) {
    const columns = useApprovalColumns
      ? 'id, email, name, contact_name, business_name, is_approved, created_at, approved_at, approved_at_inferred'
      : 'id, email, name, contact_name, business_name, is_approved, created_at';
    const { data, error } = await supabase
      .from('customers')
      .select(columns)
      .eq('is_approved', true)
      .order('id', { ascending: true })
      .range(from, from + CUSTOMER_PAGE_SIZE - 1);

    if (error && useApprovalColumns && /approved_at/i.test(error.message || '')) {
      // Preview deployments remain usable before migration 065 is applied.
      useApprovalColumns = false;
      rows.length = 0;
      from = 0;
      continue;
    }
    if (error) throw error;

    const batch = (data || []).map((row) => (useApprovalColumns ? row : {
      ...row,
      approved_at: row.created_at,
      approved_at_inferred: true,
    }));
    rows.push(...batch);
    if (batch.length < CUSTOMER_PAGE_SIZE) return rows;
    from += CUSTOMER_PAGE_SIZE;
  }
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const [campaigns, approvedCustomers] = await Promise.all([
        readEmailCampaigns(),
        fetchApprovedCustomers(),
      ]);
      return res.status(200).json(buildCampaignApprovalReport(campaigns, approvedCustomers));
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to load campaigns' });
    }
  }

  return res.status(405).end();
}
