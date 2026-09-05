import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeCodexReport } from '../lib/analytics-insights.mjs';
import { isAnalysisId, isWorkerId, validAnalyticsReport } from '../lib/analytics-report-contract.mjs';
import { callPreviewAnalyticsGateway, previewAnalyticsGatewayEnabled } from './_analytics-preview-gateway.js';

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
  const isolatedPreview = previewAnalyticsGatewayEnabled();
  if (String(process.env.VERCEL_ENV || '').trim().toLowerCase() !== 'production' && !isolatedPreview) {
    return res.status(409).json({ error: 'Apollo worker writes are disabled outside production or an explicitly isolated preview.' });
  }
  const action = String(req.body?.action || '');
  if (!['claim', 'complete', 'fail'].includes(action)) return res.status(400).json({ error: 'Unknown worker action' });
  if (!isWorkerId(req.body?.workerId)) return res.status(400).json({ error: 'A valid worker identity is required before claiming or updating a job.' });
  if (action !== 'claim' && (!isAnalysisId(req.body?.jobId) || !isAnalysisId(req.body?.claimToken))) {
    return res.status(400).json({ error: 'A valid job, claim token and worker identity are required.' });
  }
  if (action === 'complete' && !validAnalyticsReport(req.body?.result)) return res.status(400).json({ error: 'A valid structured Apollo report is required.' });

  if (isolatedPreview) {
    try {
      if (action === 'claim') {
        return res.status(200).json(await callPreviewAnalyticsGateway('claim', { workerId: String(req.body?.workerId || 'hermes').slice(0, 100) }));
      }
      const result = action === 'complete' ? normalizeCodexReport(req.body?.result || {}) : undefined;
      if (action === 'complete' && !result.summary) return res.status(400).json({ error: 'Report summary is required' });
      const payload = await callPreviewAnalyticsGateway(action, {
        jobId: req.body?.jobId,
        claimToken: req.body?.claimToken,
        workerId: String(req.body?.workerId || '').slice(0, 100),
        result,
        usage: req.body?.usage || {},
        error: req.body?.error,
      });
      return res.status(200).json(payload);
    } catch {
      return res.status(502).json({ error: 'The isolated Apollo worker connection failed. Check the preview gateway.' });
    }
  }

  const supabase = db();
  if (action === 'claim') {
    const maintenance = await supabase.rpc('run_codex_analytics_maintenance');
    if (maintenance.error) console.error('Codex analytics retention maintenance failed:', maintenance.error.message);
    const { data, error } = await supabase.rpc('claim_codex_analytics_job', { p_worker_id: String(req.body?.workerId || 'hermes').slice(0, 100) });
    if (error) return res.status(400).json({ error: error.message });
    const job = data?.[0];
    return res.status(200).json({ job: job ? { id: job.id, snapshot: job.snapshot, claimToken: job.claim_token } : null });
  }

  const id = String(req.body?.jobId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid job id' });
  const claimToken = String(req.body?.claimToken || '');
  if (!/^[0-9a-f-]{36}$/i.test(claimToken)) return res.status(400).json({ error: 'Invalid claim token' });
  const workerId = String(req.body?.workerId || '').slice(0, 100);
  if (action === 'complete') {
    const result = normalizeCodexReport(req.body?.result || {});
    if (!result.summary) return res.status(400).json({ error: 'Report summary is required' });
    const usage = req.body?.usage || {};
    const { data, error } = await supabase.rpc('complete_codex_analytics_job', {
      p_job_id: id,
      p_worker_id: workerId,
      p_claim_token: claimToken,
      p_result: result,
      p_model: String(usage.model || '').slice(0, 80),
      p_input_tokens: Math.max(0, Math.min(1000000, Number(usage.inputTokens) || 0)),
      p_output_tokens: Math.max(0, Math.min(100000, Number(usage.outputTokens) || 0)),
    });
    if (error) return res.status(400).json({ error: error.message });
    if (data !== true) return res.status(409).json({ error: 'Job lease is no longer valid' });
    return res.status(200).json({ ok: true });
  }
  if (action === 'fail') {
    const { data, error } = await supabase.rpc('fail_codex_analytics_job', {
      p_job_id: id,
      p_worker_id: workerId,
      p_claim_token: claimToken,
      p_error: String(req.body?.error || 'Codex analysis failed').slice(0, 500),
    });
    if (error) return res.status(400).json({ error: error.message });
    if (data !== true) return res.status(409).json({ error: 'Job lease is no longer valid' });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: 'Unknown worker action' });
}
