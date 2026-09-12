import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requireOwner } from './_admin-auth.js';

function sameSecret(provided, expected) {
  const actual = Buffer.from(String(provided || '').trim());
  const wanted = Buffer.from(String(expected || '').trim());
  return actual.length > 0 && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function retentionCronAuthorised(req, secret) {
  if (!secret) return false;
  const provided = req.headers?.['x-apollo-activity-retention-secret']
    || String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  return sameSecret(provided, secret);
}

function validResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const rawRemoved = result.raw_removed;
  const monthlyRemoved = result.monthly_removed;
  if (!Number.isSafeInteger(rawRemoved) || rawRemoved < 0) return null;
  if (!Number.isSafeInteger(monthlyRemoved) || monthlyRemoved < 0) return null;
  return { rawRemoved, monthlyRemoved };
}

/**
 * Dedicated client for the isolated Apollo database. This intentionally never
 * falls back to the portal database or to browser-visible variables.
 */
export function getApolloActivityRetentionClient() {
  const url = String(process.env.APOLLO_ACTIVITY_SUPABASE_URL || '').trim();
  const key = String(process.env.APOLLO_ACTIVITY_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Apollo activity database is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/**
 * Feature-disabled execution endpoint for the database-owned retention RPC.
 * It deliberately has no cron entry: scheduling is a separate release gate.
 */
export function createActivityRetentionHandler({
  enabled = () => process.env.APOLLO_ACTIVITY_RETENTION_ENABLED === 'true',
  client = getApolloActivityRetentionClient,
  requireOwnerAccess = requireOwner,
  cronSecret = () => String(process.env.APOLLO_ACTIVITY_RETENTION_CRON_SECRET || '').trim(),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!enabled()) return res.status(404).json({ error: 'Apollo activity retention is not enabled' });
    if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
      return res.status(400).json({ error: 'Retention does not accept a request payload' });
    }

    const isCron = retentionCronAuthorised(req, cronSecret());
    if (!isCron && !(await requireOwnerAccess(req, res))) return;

    let db;
    try { db = client(); } catch { return res.status(503).json({ error: 'Activity retention is unavailable' }); }
    try {
      const { data, error } = await db.rpc('apollo_retain_activity');
      if (error) return res.status(503).json({ error: 'Activity retention is unavailable' });
      const result = validResult(data);
      if (!result) return res.status(503).json({ error: 'Activity retention returned an invalid result' });
      return res.status(200).json({ ok: true, ...result });
    } catch {
      return res.status(503).json({ error: 'Activity retention is unavailable' });
    }
  };
}

export default createActivityRetentionHandler();
