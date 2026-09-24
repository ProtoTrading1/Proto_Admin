/**
 * Run a WhatsApp broadcast and record it so the analytics screen has something
 * to read.
 *
 * Consent is not decided here — `resolveWhatsappAudience` already did that, and
 * this module refuses to send to anything that resolver did not return.
 *
 * Every recipient gets its own row up front (status 'queued') so an interrupted
 * run leaves an auditable half-sent broadcast rather than a mystery.
 */

import { randomBytes } from 'crypto';
import {
  SEND_CHUNK_SIZE,
  sanitizeParam,
  watiSendTemplateBulk,
} from './_wati-client.js';
import { resolveWhatsappAudience } from './_whatsapp-audience.js';

/**
 * Merge fields an admin can type into a template parameter. Deliberately
 * distinct from WhatsApp's own positional {{1}} placeholders so the two never
 * collide: {{1}} is "the first template variable", {{name}} is "this
 * recipient's name".
 */
const MERGE_FIELDS = {
  '{{name}}': (r) => r.contactName || r.businessName || 'there',
  '{{contact_name}}': (r) => r.contactName || '',
  '{{first_name}}': (r) => String(r.contactName || '').trim().split(/\s+/)[0] || '',
  '{{business_name}}': (r) => r.businessName || '',
  '{{business}}': (r) => r.businessName || '',
};

/** The token that expands to this recipient's own tracked link. */
export const LINK_MERGE_FIELD = '{{link}}';

export function clickBaseUrl() {
  return (process.env.WHATSAPP_CLICK_BASE_URL || process.env.ADMIN_PUBLIC_URL || 'https://admin.proto.co.za')
    .replace(/\/$/, '');
}

export function trackedLinkFor(token) {
  return `${clickBaseUrl()}/api/wa-click?t=${token}`;
}

export function renderParamValue(template, recipient, trackedUrl) {
  let value = String(template ?? '');
  for (const [token, resolve] of Object.entries(MERGE_FIELDS)) {
    if (value.includes(token)) value = value.split(token).join(resolve(recipient));
  }
  if (value.includes(LINK_MERGE_FIELD)) {
    value = value.split(LINK_MERGE_FIELD).join(trackedUrl || '');
  }
  return sanitizeParam(value);
}

/** Fill a template body with the typed parameters, for the history preview. */
export function renderBodyPreview(body, parameters) {
  return String(body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => {
    const value = parameters?.[String(index)];
    return value ? String(value) : match;
  });
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {object} options
 * @param {'all'|'business-type'|'selected'} options.audience
 * @param {string} options.templateName    an APPROVED WATI template
 * @param {Record<string,string>} options.parameters  positional template values, keyed '1','2',…
 * @param {string} [options.trackedUrl]    destination for {{link}}
 * @param {boolean} [options.dryRun]       resolve the audience without sending
 */
export async function runWhatsappBroadcast(sb, {
  audience = 'all',
  businessTypes = [],
  phones = [],
  templateName,
  templateLanguage = null,
  templateBody = '',
  broadcastName,
  parameters = {},
  trackedUrl = '',
  createdBy = null,
  dryRun = false,
}) {
  const template = String(templateName || '').trim();
  if (!template) return { ok: false, error: 'Choose an approved WhatsApp template to send.' };

  const { recipients, skipped } = await resolveWhatsappAudience(sb, { audience, businessTypes, phones });

  if (dryRun) {
    return { ok: true, dryRun: true, total: recipients.length, skipped, recipients: recipients.slice(0, 20) };
  }
  if (!recipients.length) {
    return {
      ok: false,
      total: 0,
      skipped,
      error: 'No consented, reachable WhatsApp numbers in this audience.',
    };
  }

  const name = String(broadcastName || '').trim() || `${template}-${Date.now()}`;
  const startedAt = new Date().toISOString();

  const { data: broadcast, error: broadcastError } = await sb
    .from('whatsapp_broadcasts')
    .insert({
      broadcast_name: name.slice(0, 120),
      template_name: template,
      template_language: templateLanguage,
      body_preview: renderBodyPreview(templateBody, parameters),
      audience_filter: { audience, businessTypes, selectedCount: phones?.length || 0 },
      parameters,
      tracked_url: trackedUrl || null,
      total_targeted: recipients.length,
      count_skipped: skipped.length,
      status: 'sending',
      created_by: createdBy,
      started_at: startedAt,
    })
    .select('id')
    .single();
  if (broadcastError) throw broadcastError;

  const broadcastId = broadcast.id;

  // One outbound row per recipient, written before the first send so a timeout
  // mid-broadcast still leaves a complete record of who was targeted.
  const rows = recipients.map((r) => ({
    broadcast_id: broadcastId,
    phone: r.phone,
    direction: 'out',
    status: 'queued',
    template_name: template,
    customer_id: r.customerId,
    email: r.email,
    contact_name: r.contactName,
    business_name: r.businessName,
    click_token: randomBytes(9).toString('base64url'),
    sent_by: createdBy,
    queued_at: startedAt,
  }));
  for (const batch of chunk(rows, 500)) {
    const { error } = await sb.from('whatsapp_messages').insert(batch);
    if (error) throw error;
  }

  const { data: queued, error: queuedError } = await sb
    .from('whatsapp_messages')
    .select('id, phone, click_token')
    .eq('broadcast_id', broadcastId)
    .eq('direction', 'out');
  if (queuedError) throw queuedError;
  const tokenByPhone = new Map((queued || []).map((row) => [row.phone, row.click_token]));

  const paramIndexes = Object.keys(parameters || {})
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const group of chunk(recipients, SEND_CHUNK_SIZE)) {
    const receivers = group.map((r) => {
      const link = trackedUrl ? trackedLinkFor(tokenByPhone.get(r.phone)) : '';
      return {
        whatsappNumber: r.phone,
        params: paramIndexes.map((index) => ({
          name: index,
          value: renderParamValue(parameters[index], r, link),
        })),
      };
    });

    const sentAt = new Date().toISOString();
    let result;
    try {
      result = await watiSendTemplateBulk({ templateName: template, broadcastName: name, receivers });
    } catch (err) {
      // A whole chunk failed (network, expired token, WATI 5xx). Mark just this
      // chunk failed and carry on — one bad chunk must not abandon the rest.
      const message = err?.message || 'Send failed';
      result = { ok: false, error: message, messageIds: {}, failures: {} };
    }

    const chunkError = result.ok ? null : result.error;
    for (const r of group) {
      const failure = result.failures[r.phone] || chunkError || null;
      const patch = failure
        ? { status: 'failed', error: String(failure).slice(0, 500), failed_at: sentAt }
        : { status: 'sent', sent_at: sentAt, wa_message_id: result.messageIds[r.phone] || null };
      const { error } = await sb
        .from('whatsapp_messages')
        .update(patch)
        .eq('broadcast_id', broadcastId)
        .eq('phone', r.phone)
        .eq('direction', 'out');
      if (error) console.error('whatsapp broadcast: status write failed:', error.message);

      if (failure) {
        failed += 1;
        if (errors.length < 20) errors.push({ phone: r.phone, error: String(failure) });
      } else {
        sent += 1;
      }
    }

    // Best-effort: keep the contact mirror's "last messaged" column current.
    try {
      await sb
        .from('whatsapp_contacts')
        .update({
          last_outbound_at: sentAt,
          last_outbound_template: template,
          last_outbound_broadcast: broadcastId,
          last_broadcast_at: sentAt,
          updated_at: sentAt,
        })
        .in('phone', group.map((r) => r.phone));
    } catch { /* analytics only */ }
  }

  const completedAt = new Date().toISOString();
  const { error: finaliseError } = await sb
    .from('whatsapp_broadcasts')
    .update({
      status: sent === 0 ? 'failed' : 'completed',
      count_sent: sent,
      count_failed: failed,
      completed_at: completedAt,
      error: sent === 0 ? (errors[0]?.error || 'Every send was rejected') : null,
    })
    .eq('id', broadcastId);
  if (finaliseError) console.error('whatsapp broadcast: finalise failed:', finaliseError.message);

  return {
    ok: failed === 0,
    broadcastId,
    total: recipients.length,
    sent,
    failed,
    skipped,
    errors,
  };
}
