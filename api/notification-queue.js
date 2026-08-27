import { createClient } from '@supabase/supabase-js';
import { requireAdminOrOrderToken } from './_admin-auth.js';

const JOBS_TABLE = 'order_notification_jobs';
const WORKERS_TABLE = 'order_notification_worker_heartbeats';
const SAFE_JOB_COLUMNS = [
  'id',
  'order_id',
  'channel',
  'recipient_key',
  'status',
  'attempt_count',
  'max_attempts',
  'next_attempt_at',
  'locked_at',
  'lease_expires_at',
  'last_error_code',
  'last_error',
  'provider_message_id',
  'created_at',
  'updated_at',
  'completed_at',
].join(',');

const STATE_GROUPS = Object.freeze({
  queued: ['pending'],
  processing: ['processing'],
  retry: ['retry_wait'],
  deadLetter: ['dead_letter'],
});

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function isMissingQueueSchema(error) {
  const message = String(error?.message || '');
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /order_notification_(jobs|worker_heartbeats).*not find|does not exist/i.test(message);
}

function safeText(value, max = 240) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

export function publicJob(row = {}) {
  return {
    id: safeText(row.id, 80),
    orderId: safeText(row.order_id, 80),
    channel: safeText(row.channel, 40),
    recipient: safeText(row.recipient_key, 160),
    state: safeText(row.status, 40),
    attempts: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    nextRetryAt: row.next_attempt_at || null,
    leasedAt: row.locked_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    errorCode: safeText(row.last_error_code, 80),
    error: safeText(row.last_error, 240),
    providerMessageId: safeText(row.provider_message_id, 120),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
  };
}

async function stateCount(supabase, states) {
  const { count, error } = await supabase
    .from(JOBS_TABLE)
    .select('id', { count: 'exact', head: true })
    .in('status', states);
  if (error) throw error;
  return Number(count || 0);
}

async function loadWorkerHeartbeat(supabase) {
  const { data, error } = await supabase
    .from(WORKERS_TABLE)
    .select('worker_id,status,started_at,finished_at,last_error,updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingQueueSchema(error)) return null;
    throw error;
  }
  if (!data) return null;
  const lastSeenAt = data.updated_at || null;
  const ageSeconds = lastSeenAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 1000))
    : null;
  return {
    worker: safeText(data.worker_id, 80),
    lastSeenAt,
    ageSeconds,
    stale: ageSeconds == null || ageSeconds > 15 * 60,
    status: safeText(data.status, 40),
    error: safeText(data.last_error, 240),
  };
}

export default async function handler(req, res) {
  if (!(await requireAdminOrOrderToken(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const orderId = String(req.query?.orderId || '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
  const supabase = getPortalDbClient();

  try {
    const jobsQuery = supabase
      .from(JOBS_TABLE)
      .select(SAFE_JOB_COLUMNS)
      .order('updated_at', { ascending: false })
      .limit(limit);
    const { data: jobs, error: jobsError } = orderId
      ? await jobsQuery.eq('order_id', orderId)
      : await jobsQuery;
    if (jobsError) throw jobsError;

    const [queued, processing, retry, deadLetter, oldestResult, heartbeat] = await Promise.all([
      stateCount(supabase, STATE_GROUPS.queued),
      stateCount(supabase, STATE_GROUPS.processing),
      stateCount(supabase, STATE_GROUPS.retry),
      stateCount(supabase, STATE_GROUPS.deadLetter),
      supabase
        .from(JOBS_TABLE)
        .select('created_at')
        .in('status', [...STATE_GROUPS.queued, ...STATE_GROUPS.retry])
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      loadWorkerHeartbeat(supabase),
    ]);
    if (oldestResult.error) throw oldestResult.error;

    const oldestAt = oldestResult.data?.created_at || null;
    const oldestAgeSeconds = oldestAt
      ? Math.max(0, Math.floor((Date.now() - new Date(oldestAt).getTime()) / 1000))
      : null;

    return res.status(200).json({
      available: true,
      readOnly: true,
      counts: { queued, processing, retry, deadLetter },
      oldest: { at: oldestAt, ageSeconds: oldestAgeSeconds },
      heartbeat,
      jobs: (jobs || []).map(publicJob),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (isMissingQueueSchema(error)) {
      return res.status(200).json({
        available: false,
        readOnly: true,
        setupRequired: true,
        message: 'Durable notification queue tables have not been installed yet.',
        counts: { queued: 0, processing: 0, retry: 0, deadLetter: 0 },
        jobs: [],
        checkedAt: new Date().toISOString(),
      });
    }
    console.error('notification-queue:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load notification queue health' });
  }
}
