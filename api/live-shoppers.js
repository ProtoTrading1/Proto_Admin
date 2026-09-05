/**
 * Live count of signed-in customers currently browsing the storefront.
 *
 * Reads `customer_presence` (portal project, migration 065 of the
 * ProtoMainSite repo), which the storefront refreshes once a minute per open
 * visible tab. A row inside the freshness window means that customer has the
 * shop open right now.
 *
 * The window is two heartbeats wide so a single dropped request never blinks a
 * shopper out of the count, and stale rows age out on their own — nothing has
 * to prune the table, because it holds one row per customer rather than one
 * per visit.
 */
import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';

/** Must stay >= 2x the storefront's HEARTBEAT_MS (60s) in src/lib/presence.js. */
export const FRESHNESS_SECONDS = 150;

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const since = new Date(Date.now() - FRESHNESS_SECONDS * 1000).toISOString();
  const supabase = getAdminClient();

  // head:true — the rows themselves are never needed, only how many there are.
  const { count, error } = await supabase
    .from('customer_presence')
    .select('customer_id', { count: 'exact', head: true })
    .gte('last_seen_at', since);

  if (error) {
    // The portal owns migration 065. Until it is applied the feature is simply
    // not available yet — that is not a dashboard error worth alarming anyone.
    if (/does not exist/i.test(error.message || '')) {
      return res.status(200).json({ available: false, count: 0, freshnessSeconds: FRESHNESS_SECONDS });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({
    available: true,
    count: count || 0,
    freshnessSeconds: FRESHNESS_SECONDS,
  });
}
