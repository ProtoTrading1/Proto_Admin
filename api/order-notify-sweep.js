import { createClient } from '@supabase/supabase-js';
import { requireCronOrAdminKey } from './_admin-auth.js';
import { isOrderNotifyComplete, notifyNewOrder } from './_order-notify-core.js';
import { readOrderNotifyLog } from './_site-config.js';

const SWEEP_WINDOW_DAYS = 14;
const SWEEP_BATCH = 20;
// Back off between retries for the same order so a persistently failing
// round (e.g. Brevo outage) can't re-send the alert email every 10 min.
const SWEEP_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Cron safety net: any recent order still in "pending" without a completed
 * notification round (alert email + stored PDF) gets its notifications
 * (re)triggered, so new orders are announced even when nobody has the admin
 * portal open.
 */
export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const since = new Date(Date.now() - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = getPortalDbClient();
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_number, status, created_at')
    .eq('status', 'pending')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SWEEP_BATCH);
  if (error) return res.status(400).json({ error: error.message });

  const results = [];
  for (const order of orders || []) {
    try {
      const log = await readOrderNotifyLog(String(order.id));
      const complete = isOrderNotifyComplete(log);
      if (complete.ok) {
        results.push({ orderId: order.id, skipped: true, reason: 'already_notified' });
        continue;
      }
      const lastAttempt = Date.parse(log?.at || log?.updatedAt || '') || 0;
      if (lastAttempt && Date.now() - lastAttempt < SWEEP_RETRY_BACKOFF_MS) {
        results.push({ orderId: order.id, skipped: true, reason: 'retry_backoff' });
        continue;
      }
      const outcome = await notifyNewOrder(order.id);
      results.push({
        orderId: order.id,
        orderNumber: order.order_number,
        emailSent: outcome.emailSent,
        pdfStored: outcome.pdfStored ?? null,
        statusAdvanced: outcome.statusAdvanced ?? null,
        error: outcome.error || outcome.emailError || null,
      });
    } catch (err) {
      results.push({ orderId: order.id, error: err.message || 'sweep_failed' });
    }
  }

  return res.status(200).json({
    ok: true,
    scanned: (orders || []).length,
    notified: results.filter((r) => !r.skipped && !r.error).length,
    results,
  });
}
