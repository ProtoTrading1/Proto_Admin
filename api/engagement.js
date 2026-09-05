/**
 * Engagement — who is actually using the site, and what the email is doing.
 *
 * Reads three sources that begin at different dates:
 *   customer_visits            (ProtoMainSite migration 066) browsing sessions
 *   customer_journey_events    'cart_item_added', same migration
 *   the campaign log           email sends, which long predates both
 *
 * Each is reported with its own availability flag. A missing table means the
 * storefront release has not landed yet — that is "no data recorded", not an
 * error, and definitely not a zero that reads as "nobody visited".
 */
import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { readEmailCampaigns } from './_email-campaigns.js';
import {
  RANGES,
  buildVisitorRows,
  dailyCounts,
  dailyUniqueCustomers,
  rangeStart,
  summariseCartAdds,
  summariseEmail,
  summariseVisits,
} from '../lib/engagement.mjs';

export const config = { maxDuration: 30 };

const PAGE = 1000;
const CUSTOMER_COLUMNS = 'id, name, contact_name, first_name, business_name, email, customer_code';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function missingTable(error) {
  return /does not exist/i.test(error?.message || '');
}

/** Pages a filtered read; returns `null` when the table is not there yet. */
async function fetchAll(build) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build().range(offset, offset + PAGE - 1);
    if (error) {
      if (missingTable(error)) return null;
      throw error;
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
    offset += PAGE;
  }
}

/**
 * Names a specific set of customers. Chunked because an `in` list becomes a
 * query-string filter, and a few hundred uuids would overrun the URL.
 */
async function fetchCustomersByIds(supabase, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];

  const rows = [];
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .in('id', unique.slice(i, i + 200));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const range = RANGES[req.query.range] ? String(req.query.range) : 'week';
  const since = rangeStart(range);
  const sinceIso = since.toISOString();
  const supabase = getAdminClient();

  try {
    const [visits, cartEvents, campaigns] = await Promise.all([
      fetchAll(() => supabase
        .from('customer_visits')
        .select('customer_id, session_id, started_at, last_seen_at')
        .gte('started_at', sinceIso)
        .order('started_at', { ascending: false })),
      fetchAll(() => supabase
        .from('customer_journey_events')
        .select('customer_id, created_at, metadata')
        .eq('event_type', 'cart_item_added')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })),
      readEmailCampaigns().catch(() => []),
    ]);

    const visitSummary = summariseVisits(visits || []);

    // Only the customers who actually visited — reading the whole table to
    // name a handful of visitors would grow with the customer base rather
    // than with the answer.
    const customers = await fetchCustomersByIds(
      supabase,
      visitSummary.byCustomer.map((row) => row.customerId),
    );

    return res.status(200).json({
      range,
      since: sinceIso,
      browsing: {
        available: visits !== null,
        ...visitSummary,
        // byCustomer is replaced by the joined list below; the raw ids are of
        // no use to the panel.
        byCustomer: undefined,
        daily: dailyUniqueCustomers(visits || [], 'started_at'),
        visitors: buildVisitorRows(visitSummary, customers || []),
      },
      cart: {
        available: cartEvents !== null,
        ...summariseCartAdds(cartEvents || []),
        daily: dailyUniqueCustomers(cartEvents || [], 'created_at'),
        dailyAdds: dailyCounts(cartEvents || [], 'created_at'),
      },
      email: summariseEmail(campaigns || [], since),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Engagement could not be loaded' });
  }
}
