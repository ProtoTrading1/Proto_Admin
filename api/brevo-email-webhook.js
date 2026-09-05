import { timingSafeEqual } from 'crypto';
import { recordEmailWebhookEvent } from './_email-campaigns.js';

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.replace(/^Bearer\s+/i, '').trim();
}

function extractMessageId(payload = {}) {
  return String(
    payload['message-id']
    || payload.messageId
    || payload.message_id
    || payload['message-id-guid']
    || payload.uuid
    || payload.id
    || '',
  ).trim();
}

function extractEvent(payload = {}) {
  return String(payload.event || payload.type || payload.reason || '').trim();
}

function extractEmail(payload = {}) {
  return String(payload.email || payload.recipient || payload.to || '').trim().toLowerCase();
}

/** Brevo transactional webhook — authenticate with the X-Webhook-Secret header. */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  // Production must fail closed. Configure this secret in Vercel, then send
  // it from Brevo as X-Webhook-Secret (preferred) or Authorization: Bearer.
  // Query-string secrets are deliberately not accepted because URLs leak into
  // logs, browser history, and monitoring tools.
  const webhookSecret = String(process.env.WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) {
    console.error('brevo-email-webhook: WEBHOOK_SECRET is not configured; rejecting event.');
    return res.status(503).json({ error: 'Webhook authentication is not configured' });
  }
  const headerSecret = String(req.headers['x-webhook-secret'] || '').trim();
  if (!safeEqual(headerSecret, webhookSecret) && !safeEqual(bearerToken(req), webhookSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body || {};
  const items = Array.isArray(payload) ? payload : [payload];

  try {
    let updated = 0;
    let unmatched = 0;
    for (const item of items) {
      const messageId = extractMessageId(item);
      const event = extractEvent(item);
      if (!messageId || !event) continue;
      const result = await recordEmailWebhookEvent({
        messageId,
        event,
        email: extractEmail(item),
        link: String(item.link || item.url || '').trim() || null,
        meta: { subject: item.subject },
      });
      if (result && result !== false && !result?.abort) updated += 1;
      else unmatched += 1;
    }
    // Surface silent drops: an event whose message-id matches no known campaign
    // means the send path didn't capture that id (e.g. a transactional email).
    if (unmatched) {
      console.warn(`brevo-email-webhook: ${unmatched} event(s) did not match any campaign message-id (${items.length} received).`);
    }
    return res.status(200).json({ ok: true, updated, unmatched });
  } catch (err) {
    console.error('brevo-email-webhook:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Webhook processing failed' });
  }
}
