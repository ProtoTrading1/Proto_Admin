import { timingSafeEqual } from 'crypto';
import {
  getWhatsappDbClient,
  isOptOutMessage,
  recordWhatsappOptOut,
} from './_whatsapp-audience.js';

/**
 * WATI inbound webhook — delivery receipts, reads, replies and opt-outs.
 *
 * Authenticate with WHATSAPP_WEBHOOK_SECRET, sent by WATI as an
 * `X-Webhook-Secret` header (add it under the webhook's custom headers) or as
 * `Authorization: Bearer <secret>`. It fails closed: with no secret configured
 * nothing is accepted, because this endpoint can flip a customer's consent and
 * an unauthenticated caller must never be able to do that.
 *
 * Query-string secrets are deliberately not accepted — URLs leak into logs.
 *
 * WATI's payload shape varies by event, so every field is read defensively and
 * an unrecognised event is logged rather than dropped silently.
 */

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

const SENT = new Set(['sentmessage', 'message_sent', 'sent', 'templatemessagesent']);
const DELIVERED = new Set(['deliveredmessage', 'message_delivered', 'delivered']);
const READ = new Set(['readmessage', 'message_read', 'read', 'seen']);
const FAILED = new Set(['failedmessage', 'message_failed', 'failed', 'undelivered', 'rejected']);
const INBOUND = new Set(['message', 'newmessage', 'message_received', 'incomingmessage']);

function classify(payload) {
  const raw = String(payload?.eventType || payload?.event || payload?.type || '').trim().toLowerCase();
  const statusText = String(payload?.statusString || payload?.status || '').trim().toLowerCase();
  const key = raw.replace(/[\s-]/g, '');

  if (FAILED.has(key) || FAILED.has(statusText)) return 'failed';
  if (READ.has(key) || READ.has(statusText)) return 'read';
  if (DELIVERED.has(key) || DELIVERED.has(statusText)) return 'delivered';
  if (SENT.has(key) || SENT.has(statusText)) return 'sent';
  // An inbound text is only a reply when it came FROM the customer. WATI marks
  // its own outbound copies with owner/fromMe, and treating one of those as a
  // reply would credit us with the customer's engagement.
  if (INBOUND.has(key)) {
    const fromCustomer = payload?.owner === false || payload?.fromMe === false
      || String(payload?.eventType || '').toLowerCase() === 'message';
    return fromCustomer && payload?.owner !== true && payload?.fromMe !== true ? 'replied' : 'ignored';
  }
  return 'unknown';
}

function phoneOf(payload) {
  return String(payload?.waId || payload?.whatsappNumber || payload?.phone || payload?.wa_id || '').replace(/\D/g, '');
}

function messageIdOf(payload) {
  return String(payload?.whatsappMessageId || payload?.messageId || payload?.id || payload?.message_id || '').trim();
}

function occurredAt(payload) {
  const raw = payload?.timestamp ?? payload?.created ?? payload?.eventTime;
  if (raw == null) return new Date().toISOString();
  // WATI sends both epoch seconds (as a string) and ISO strings.
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000 && numeric < 100_000_000_000) {
    return new Date(numeric * 1000).toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * Find the outbound row an event belongs to.
 *
 * WATI's bulk send does not promise a per-receiver message id, so the id is
 * often learned from the first webhook rather than the send response. Match on
 * the id when we already know it, otherwise claim the most recent outbound row
 * for that number and record the id on it.
 */
async function findOutboundRow(sb, { phone, messageId }) {
  if (messageId) {
    const { data } = await sb
      .from('whatsapp_messages')
      .select('id, broadcast_id, status, delivered_at, read_at')
      .eq('wa_message_id', messageId)
      .maybeSingle();
    if (data) return data;
  }
  if (!phone) return null;

  const { data } = await sb
    .from('whatsapp_messages')
    .select('id, broadcast_id, status, delivered_at, read_at, wa_message_id')
    .eq('phone', phone)
    .eq('direction', 'out')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  if (messageId && !data.wa_message_id) {
    await sb.from('whatsapp_messages').update({ wa_message_id: messageId }).eq('id', data.id);
  }
  return data;
}

function isDuplicateKey(error) {
  return error?.code === '23505' || /duplicate key|already exists/i.test(String(error?.message || ''));
}

/**
 * Append to the raw event log. A replay is expected — WATI retries — so a
 * duplicate event_key is a no-op, and a log failure never fails the webhook.
 */
async function logEvent(sb, row) {
  try {
    const { error } = await sb.from('whatsapp_webhook_events').insert(row);
    if (error && !isDuplicateKey(error)) {
      console.error('wati-webhook: event log write failed:', error.message);
    }
  } catch (err) {
    console.error('wati-webhook: event log write failed:', err?.message || err);
  }
}

// Delivery events arrive out of order often enough that a naive write would
// downgrade a read message back to "delivered". Status only ever moves forward.
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyDeliveryEvent(sb, row, kind, at, payload) {
  const patch = {};
  if (kind === 'delivered' && !row.delivered_at) patch.delivered_at = at;
  if (kind === 'read') {
    if (!row.read_at) patch.read_at = at;
    // A read implies a delivery WhatsApp may never have told us about.
    if (!row.delivered_at) patch.delivered_at = at;
  }
  if (kind === 'failed') {
    patch.failed_at = at;
    patch.error = String(payload?.eventDescription || payload?.error || payload?.failureReason || 'WhatsApp could not deliver this message').slice(0, 500);
  }
  if (kind === 'sent') patch.sent_at = row.sent_at || at;

  const nextStatus = kind === 'sent' ? 'sent' : kind;
  if ((STATUS_RANK[nextStatus] ?? 0) > (STATUS_RANK[row.status] ?? 0)) patch.status = nextStatus;

  if (!Object.keys(patch).length) return;
  await sb.from('whatsapp_messages').update(patch).eq('id', row.id);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const secret = String(process.env.WHATSAPP_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('wati-webhook: WHATSAPP_WEBHOOK_SECRET is not configured; rejecting event.');
    return res.status(503).json({ error: 'Webhook authentication is not configured' });
  }
  const headerSecret = String(req.headers['x-webhook-secret'] || '').trim();
  if (!safeEqual(headerSecret, secret) && !safeEqual(bearerToken(req), secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const items = Array.isArray(body) ? body : [body];

  const sb = getWhatsappDbClient();
  let handled = 0;
  let optOuts = 0;
  let unknown = 0;

  for (const payload of items) {
    const kind = classify(payload);
    const phone = phoneOf(payload);
    const messageId = messageIdOf(payload);
    const at = occurredAt(payload);
    const text = String(payload?.text || payload?.body || payload?.message || '').slice(0, 2000);

    if (kind === 'unknown') unknown += 1;

    let row = null;
    try {
      if (kind !== 'ignored' && kind !== 'unknown') {
        row = await findOutboundRow(sb, { phone, messageId });
      }

      if (row && ['sent', 'delivered', 'read', 'failed'].includes(kind)) {
        await applyDeliveryEvent(sb, row, kind, at, payload);
        handled += 1;
      }

      if (kind === 'replied') {
        // Log the inbound message itself, and credit the broadcast it answers.
        // wa_message_id is uniquely indexed, so a replayed webhook is a
        // duplicate-key error, not a second copy of the customer's message.
        const { error: inboundError } = await sb.from('whatsapp_messages').insert({
          phone,
          direction: 'in',
          status: 'received',
          body: text || null,
          wa_message_id: messageId || null,
          message_type: payload?.type || null,
          created_at: at,
        });
        if (inboundError && !isDuplicateKey(inboundError)) throw inboundError;

        if (row && !row.replied_at) {
          await sb.from('whatsapp_messages').update({ replied_at: at }).eq('id', row.id);
        }
        await sb.from('whatsapp_contacts').update({
          last_inbound_at: at,
          last_inbound_preview: text ? text.slice(0, 200) : null,
          updated_at: at,
        }).eq('phone', phone);
        handled += 1;

        // The opt-out path. "STOP" must work on the first message, without a
        // human reading the reply — that is the whole promise of an opt-out.
        if (isOptOutMessage(text)) {
          await recordWhatsappOptOut(sb, {
            phone,
            source: 'customer_reply',
            reason: `Replied: ${text.slice(0, 120)}`,
          });
          optOuts += 1;
        }
      }

      // Repeated hard failures mean the number is not on WhatsApp. Suppress it
      // so every future broadcast stops paying for the same rejection.
      if (kind === 'failed' && /not a? ?whatsapp|invalid|does not exist|unregistered/i.test(
        String(payload?.eventDescription || payload?.error || ''),
      )) {
        await recordWhatsappOptOut(sb, {
          phone,
          source: 'failed_delivery',
          reason: 'WhatsApp reports this number cannot receive messages',
        });
        optOuts += 1;
      }

      await logEvent(sb, {
        event_key: messageId ? `${messageId}:${kind}` : null,
        event_type: kind,
        phone: phone || null,
        wa_message_id: messageId || null,
        broadcast_id: row?.broadcast_id || null,
        text_body: text || null,
        payload,
        handled: kind !== 'unknown',
        received_at: at,
      });
    } catch (err) {
      console.error('wati-webhook item:', err?.message || err);
      await logEvent(sb, {
        event_type: kind,
        phone: phone || null,
        wa_message_id: messageId || null,
        payload,
        handled: false,
        handler_error: String(err?.message || err).slice(0, 500),
        received_at: at,
      });
    }
  }

  // Always 200 for an authenticated call: WATI retries on a non-2xx and a
  // replayed batch would re-log every event.
  return res.status(200).json({ ok: true, received: items.length, handled, optOuts, unknown });
}
