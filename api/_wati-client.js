/**
 * WATI (WhatsApp Business API) client for the WhatsApp CRM.
 *
 * Kept separate from `_wati-notify.js` on purpose. That module is the internal
 * fulfilment-team alert and is guarded by a test asserting nothing else imports
 * it; this module is the consented customer CRM. Two callers, two blast radii.
 *
 * Nothing here decides WHO may be messaged — that is `_whatsapp-audience.js`.
 * This file only speaks HTTP to WATI.
 *
 * Fails closed: with no WATI_API_TOKEN every call reports "not configured"
 * rather than half-completing a broadcast.
 */

const DEFAULT_BASE_URL = 'https://live-mt-server.wati.io/10138950';
const REQUEST_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 60_000;
// WATI accepts large receiver arrays but a rejected chunk is all-or-nothing, so
// smaller chunks mean a bad number costs 100 sends' worth of uncertainty, not
// the whole broadcast.
export const SEND_CHUNK_SIZE = 100;

export function watiCrmConfig() {
  const baseUrl = (process.env.WATI_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const token = process.env.WATI_API_TOKEN || '';
  return { baseUrl, token, configured: Boolean(token) };
}

export class WatiNotConfiguredError extends Error {
  constructor() {
    super('WATI is not configured. Set WATI_API_TOKEN (and WATI_API_URL) in Vercel.');
    this.name = 'WatiNotConfiguredError';
    this.statusCode = 503;
  }
}

/**
 * One place for every WATI request.
 *
 * The token is a bearer JWT and must never reach a log line or an error message
 * the browser can see, so failures report status + WATI's own message only.
 */
async function watiRequest(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { baseUrl, token, configured } = watiCrmConfig();
  if (!configured) throw new WatiNotConfiguredError();

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new Error(timedOut ? `WATI did not respond within ${Math.round(timeoutMs / 1000)}s` : 'Could not reach WATI');
  }

  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }

  if (!res.ok) {
    const message = String(json?.message || json?.info || json?.error || '').trim();
    if (res.status === 401 || res.status === 403) {
      throw new Error('WATI rejected the API token — it may have expired. Refresh WATI_API_TOKEN in Vercel.');
    }
    throw new Error(message ? `WATI: ${message}` : `WATI returned ${res.status}`);
  }
  return json;
}

/** WATI answers 200 with `result: false` for a rejected number. */
function readSendFailure(json) {
  const info = String(json?.info || json?.message || json?.error || '').trim();
  if (json?.validWhatsAppNumber === false) return 'Not a WhatsApp number';
  if (json?.result === false) return info || 'Rejected by WATI (number not reachable on WhatsApp)';
  if (info && /undeliverable|invalid phone|not a valid|failed|error/i.test(info)) return info;
  return null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Approved templates, for the broadcast composer.
 *
 * A broadcast is always a template send: outside a 24-hour customer-initiated
 * window WhatsApp only delivers pre-approved templates, so a free-text
 * composer would look like it worked and deliver nothing.
 */
export async function watiListTemplates() {
  const templates = [];
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const json = await watiRequest(`/api/v1/getMessageTemplates?pageSize=100&pageNumber=${pageNumber}`);
    const page = json?.messageTemplates || json?.data || [];
    if (!Array.isArray(page) || page.length === 0) break;
    templates.push(...page);
    if (page.length < 100) break;
  }

  return templates.map((t) => {
    const body = String(t?.body || '');
    return {
      id: t?.id || t?.elementName || null,
      name: t?.elementName || t?.name || '',
      category: t?.category || null,
      status: String(t?.status || '').toUpperCase(),
      language: t?.language?.key || t?.language?.text || t?.language || null,
      header: t?.header?.text || null,
      body,
      footer: t?.footer || null,
      buttons: Array.isArray(t?.buttons) ? t.buttons : [],
      // WhatsApp body placeholders are positional: {{1}}, {{2}}… The composer
      // renders one input per placeholder, so count the distinct ones.
      placeholders: [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))]
        .sort((a, b) => a - b),
    };
  }).filter((t) => t.name);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Add or update one contact.
 *
 * `allowBroadcast` is set from OUR consent record, never assumed: the caller
 * only ever passes a customer who has accept_whatsapp = true and no opt-out.
 */
export async function watiUpsertContact(phone, { name, customParams = [] } = {}) {
  const json = await watiRequest(`/api/v1/addContact/${encodeURIComponent(phone)}`, {
    method: 'POST',
    body: {
      name: name || 'Customer',
      customParams: customParams
        .filter((p) => p && p.name)
        .map((p) => ({ name: String(p.name), value: sanitizeParam(p.value, 200) })),
    },
  });
  const failure = readSendFailure(json);
  if (failure) return { ok: false, error: failure, contact: null };
  const contact = json?.contact || json?.data || json || {};
  return {
    ok: true,
    error: null,
    contact: {
      id: contact?.id != null ? String(contact.id) : null,
      allowBroadcast: contact?.allowBroadcast ?? null,
      optedIn: contact?.optedIn ?? null,
    },
  };
}

/**
 * Every contact WATI holds, for reconciliation.
 *
 * Used to pull back opt-outs that happened inside WhatsApp (a customer tapping
 * "Stop promotions" flips allowBroadcast in WATI, not in our database), so the
 * suppression list stays honest without us seeing the reply.
 */
export async function watiListContacts({ maxContacts = 20_000 } = {}) {
  const contacts = [];
  const pageSize = 500;
  for (let pageNumber = 1; contacts.length < maxContacts; pageNumber += 1) {
    const json = await watiRequest(`/api/v1/getContacts?pageSize=${pageSize}&pageNumber=${pageNumber}`);
    const page = json?.contact_list || json?.contacts || json?.data || [];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const c of page) {
      contacts.push({
        id: c?.id != null ? String(c.id) : null,
        phone: String(c?.wAid || c?.phone || '').replace(/\D/g, ''),
        name: c?.fullName || c?.firstName || null,
        allowBroadcast: c?.allowBroadcast ?? null,
        optedIn: c?.optedIn ?? null,
        contactStatus: c?.contactStatus || null,
      });
    }
    if (page.length < pageSize) break;
  }
  return contacts.filter((c) => c.phone);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * WhatsApp template variables reject newlines, tabs and 4+ consecutive spaces;
 * one pasted line break fails the whole chunk.
 */
export function sanitizeParam(value, maxLen = 900) {
  let text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text;
}

/**
 * Send one template to a chunk of receivers.
 *
 * @param {{whatsappNumber: string, params: Array<{name: string, value: string}>}[]} receivers
 * @returns {Promise<{ok: boolean, error: string|null, messageIds: Record<string, string>, failures: Record<string, string>}>}
 *   `messageIds` and `failures` are keyed by phone. WATI's bulk endpoint does
 *   not promise a per-receiver message id, so an empty `messageIds` is normal
 *   and the webhook falls back to matching on phone.
 */
export async function watiSendTemplateBulk({ templateName, broadcastName, receivers }) {
  const json = await watiRequest('/api/v2/sendTemplateMessages', {
    method: 'POST',
    timeoutMs: SEND_TIMEOUT_MS,
    body: {
      template_name: templateName,
      broadcast_name: broadcastName,
      receivers: receivers.map((r) => ({
        whatsappNumber: r.whatsappNumber,
        customParams: (r.params || []).map((p) => ({ name: String(p.name), value: sanitizeParam(p.value) })),
      })),
    },
  });

  const chunkFailure = readSendFailure(json);
  const messageIds = {};
  const failures = {};

  const reported = Array.isArray(json?.receivers) ? json.receivers
    : Array.isArray(json?.results) ? json.results : [];
  for (const entry of reported) {
    const phone = String(entry?.whatsappNumber || entry?.phone || entry?.wAid || '').replace(/\D/g, '');
    if (!phone) continue;
    const id = entry?.messageId || entry?.whatsappMessageId || entry?.id;
    if (id) messageIds[phone] = String(id);
    const entryFailure = readSendFailure(entry);
    if (entryFailure) failures[phone] = entryFailure;
  }

  // WATI also returns a plain `errors` object/array on partial rejection.
  const errorList = Array.isArray(json?.errors) ? json.errors
    : json?.errors && typeof json.errors === 'object' ? Object.entries(json.errors).map(([k, v]) => ({ whatsappNumber: k, error: v }))
      : [];
  for (const entry of errorList) {
    const phone = String(entry?.whatsappNumber || entry?.phone || '').replace(/\D/g, '');
    const message = String(entry?.error || entry?.message || 'Rejected by WATI').trim();
    if (phone) failures[phone] = message;
  }

  return { ok: !chunkFailure, error: chunkFailure, messageIds, failures };
}
