import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { requireAdminKey } from './_admin-auth.js';
import { checkRateLimit, clientIp } from './_rate-limit.js';
import { normalizeCodexSnapshot } from '../lib/analytics-insights.mjs';

function db() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const supabase = db();

  if (req.method === 'POST') {
    const limit = await checkRateLimit({ bucket: `codex-analytics:${clientIp(req)}`, max: 10, windowSeconds: 3600 });
    if (!limit.allowed) return res.status(429).json({ error: 'Codex analysis limit reached. Try again later.' });
    const snapshot = normalizeCodexSnapshot(req.body?.snapshot || {});
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const { data, error } = await supabase.rpc('enqueue_codex_analytics_job', {
      p_snapshot: snapshot,
      p_snapshot_hash: snapshotHash,
      p_requested_by: `admin:${clientIp(req)}`,
    });
    if (error) return res.status(400).json({ error: error.message });
    const job = data?.[0];
    if (!job) return res.status(503).json({ error: 'Codex analytics queue is unavailable.' });
    return res.status(job.status === 'completed' ? 200 : 202).json({ id: job.id, status: job.status, requested_at: job.requested_at });
  }

  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'A valid job id is required.' });
    const { data, error } = await supabase.from('codex_analytics_jobs').select('id, status, result, error, requested_at, started_at, completed_at').eq('id', id).maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Analytics job not found.' });
    return res.status(200).json(data);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
