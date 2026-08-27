import { verifyAdminUser } from './_admin-auth.js';
import { getPortalAdminClient } from './_site-config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRYABLE_STATUSES = new Set(['dead_letter', 'retry_wait']);
const MAX_REASON_LENGTH = 240;

function cleanReason(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  // Manual retries require a verified human admin session. Order links and the
  // server-to-server dashboard key deliberately cannot replay queue jobs.
  const admin = await verifyAdminUser(req);
  if (!admin?.email) return res.status(401).json({ error: 'Verified admin sign-in required' });

  const jobId = String(req.body?.jobId || '').trim();
  if (!UUID_RE.test(jobId)) return res.status(400).json({ error: 'A valid queue job ID is required' });
  const reason = cleanReason(req.body?.reason) || 'Manual retry from notification queue health';
  const actor = String(admin.email).trim().toLowerCase().slice(0, 160);
  const supabase = getPortalAdminClient();

  try {
    const { data: job, error: readError } = await supabase
      .from('order_notification_jobs')
      .select('id,status,order_id,channel,recipient_key')
      .eq('id', jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!job) return res.status(404).json({ error: 'Queue job not found' });
    if (!RETRYABLE_STATUSES.has(job.status)) {
      return res.status(409).json({
        error: `Only retry_wait or dead_letter jobs can be retried; this job is ${job.status}.`,
      });
    }

    const { data, error } = await supabase.rpc('retry_order_notification_job', {
      p_job_id: jobId,
      p_actor: actor,
      p_reason: reason,
    });
    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : data;
    return res.status(200).json({
      ok: true,
      jobId,
      orderId: job.order_id,
      channel: job.channel,
      recipient: job.recipient_key,
      status: result?.status || 'pending',
      actor,
      reason,
    });
  } catch (error) {
    console.error('notification-queue-retry:', error?.message || error);
    return res.status(500).json({ error: 'Failed to retry this notification job' });
  }
}
