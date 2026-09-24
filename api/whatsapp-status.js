import { requireAdminKey } from './_admin-auth.js';
import { WatiNotConfiguredError, watiCrmConfig, watiListTemplates } from './_wati-client.js';
import { getWhatsappDbClient } from './_whatsapp-audience.js';

/**
 * Live "is WhatsApp actually connected?" check for the CRM header.
 *
 * Deliberately makes a REAL authenticated call to WATI rather than just looking
 * for the env var. A token that is present but expired is the failure mode that
 * matters — it looks configured, and every broadcast fails at send time. A green
 * dot has to mean "we just talked to WATI", not "a variable is set".
 *
 * It also reports webhook health separately, because the two halves fail
 * independently: sending can work perfectly while the webhook secret is wrong,
 * and the symptom is silent — every broadcast shows 0 delivered, 0 read forever.
 *
 * GET → { configured, connected, reason, templates, webhook }
 */

// A hard 8s ceiling: this runs on every visit to the tab and must never be the
// reason the page feels slow.
const PING_TIMEOUT_MS = 8_000;

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');

  const { configured, baseUrl } = watiCrmConfig();
  // The tenant id is the last path segment of the WATI server URL. Useful for
  // confirming the right account at a glance; it is not a credential.
  const tenantId = baseUrl.split('/').filter(Boolean).pop() || null;

  const status = {
    configured,
    connected: false,
    reason: null,
    tenantId,
    templates: { approved: 0, pending: 0 },
    webhook: {
      secretConfigured: Boolean(String(process.env.WHATSAPP_WEBHOOK_SECRET || '').trim()),
      lastEventAt: null,
      eventsLast7Days: 0,
    },
    checkedAt: new Date().toISOString(),
  };

  if (!configured) {
    status.reason = 'WATI_API_TOKEN is not set in Vercel.';
    return res.status(200).json(status);
  }

  const [ping, webhook] = await Promise.allSettled([
    pingWati(),
    readWebhookHealth(),
  ]);

  if (ping.status === 'fulfilled') {
    status.connected = true;
    status.templates = ping.value;
  } else {
    status.reason = ping.reason instanceof WatiNotConfiguredError
      ? ping.reason.message
      : String(ping.reason?.message || 'Could not reach WATI');
  }

  if (webhook.status === 'fulfilled') {
    status.webhook = { ...status.webhook, ...webhook.value };
  }

  // Connected but nothing ever arrived: almost always the X-Webhook-Secret
  // header missing or mistyped on the WATI side. Say so, rather than leaving an
  // admin to wonder why every broadcast reads 0 delivered.
  if (status.connected && !status.webhook.lastEventAt) {
    status.reason = status.webhook.secretConfigured
      ? 'Connected to WATI, but no webhook events have arrived yet. Check the webhook URL and its X-Webhook-Secret header in WATI.'
      : 'Connected to WATI, but WHATSAPP_WEBHOOK_SECRET is not set — delivery, read and click data cannot be recorded.';
  }

  return res.status(200).json(status);
}

/** Cheapest authenticated WATI call that proves the token still works. */
async function pingWati() {
  const templates = await Promise.race([
    watiListTemplates(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`WATI did not respond within ${PING_TIMEOUT_MS / 1000}s`)),
      PING_TIMEOUT_MS,
    )),
  ]);
  return {
    approved: templates.filter((t) => t.status === 'APPROVED').length,
    pending: templates.filter((t) => t.status !== 'APPROVED').length,
  };
}

async function readWebhookHealth() {
  const sb = getWhatsappDbClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [latest, recent] = await Promise.all([
    sb.from('whatsapp_webhook_events')
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from('whatsapp_webhook_events')
      .select('id', { count: 'exact', head: true })
      .gte('received_at', since),
  ]);

  return {
    lastEventAt: latest?.data?.received_at || null,
    eventsLast7Days: recent?.count || 0,
  };
}
