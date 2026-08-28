import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeCodexReport } from '../lib/analytics-insights.mjs';

function safeEqual(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length > 0 && one.length === two.length && timingSafeEqual(one, two);
}

function db() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!safeEqual(req.headers['x-codex-worker-secret'], process.env.CODEX_ANALYTICS_WORKER_SECRET)) return res.status(401).json({ error: 'Worker authentication required' });
  const supabase = db();
  const action = String(req.body?.action || '');

  if (action === 'claim') {
    const { data, error } = await supabase.rpc('claim_codex_analytics_job', { p_worker_id: String(req.body?.workerId || 'hermes').slice(0, 100) });
    if (error) return res.status(400).json({ error: error.message });
    const job = data?.[0];
    return res.status(200).json({ job: job ? { id: job.id, snapshot: job.snapshot, claimToken: job.claim_token } : null });
  }

  const id = String(req.body?.jobId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid job id' });
  if (action === 'complete') {
    const result = normalizeCodexReport(req.body?.result || {});
    if (!result.summary) return res.status(400).json({ error: 'Report summary is required' });
    const claimToken = String(req.body?.claimToken || '');
    const usage = req.body?.usage || {};
    const { data, error } = await supabase.from('codex_analytics_jobs').update({
      status: 'completed', result, error: null, completed_at: new Date().toISOString(), lease_until: null, claim_token: null,
      input_tokens: Math.max(0, Math.min(1000000, Number(usage.inputTokens) || 0)),
      output_tokens: Math.max(0, Math.min(100000, Number(usage.outputTokens) || 0)),
      model: String(usage.model || '').slice(0, 80),
    }).eq('id', id).eq('status', 'running').eq('worker_id', String(req.body?.workerId || '')).eq('claim_token', claimToken).gt('lease_until', new Date().toISOString()).select('id');
    if (error) return res.status(400).json({ error: error.message });
    if (!data?.length) return res.status(409).json({ error: 'Job lease is no longer valid' });
    return res.status(200).json({ ok: true });
  }
  if (action === 'fail') {
    const { data, error } = await supabase.from('codex_analytics_jobs').update({ status: 'failed', error: String(req.body?.error || 'Codex analysis failed').slice(0, 500), completed_at: new Date().toISOString(), lease_until: null, claim_token: null }).eq('id', id).eq('status', 'running').eq('worker_id', String(req.body?.workerId || '')).eq('claim_token', String(req.body?.claimToken || '')).gt('lease_until', new Date().toISOString()).select('id');
    if (error) return res.status(400).json({ error: error.message });
    if (!data?.length) return res.status(409).json({ error: 'Job lease is no longer valid' });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: 'Unknown worker action' });
}
