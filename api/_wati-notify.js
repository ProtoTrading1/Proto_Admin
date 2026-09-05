/**
 * WATI (WhatsApp Business) sender — INTERNAL TEAM ONLY.
 *
 * Outgoing WhatsApp to CUSTOMERS was removed deliberately and stays removed.
 * This module exists solely to notify the fulfilment team about a new order,
 * to numbers held in `fulfillment/users.json`. Do not point it at a customer.
 *
 * Fails closed: with no WATI_API_TOKEN nothing is sent and the caller gets a
 * clear "not configured" result rather than a half-broadcast.
 */

const DEFAULT_BASE_URL = 'https://live-mt-server.wati.io/10138950';

export const NEW_ORDER_TEMPLATE = process.env.WATI_NEW_ORDER_TEMPLATE || 'order_received_team';

export function watiConfig() {
  const baseUrl = (process.env.WATI_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const token = process.env.WATI_API_TOKEN || '';
  return { baseUrl, token, configured: Boolean(token) };
}

/**
 * WhatsApp template variables reject newlines, tabs and 4+ consecutive spaces.
 * A business name pasted with a line break would fail the whole send, so every
 * value is flattened before it goes near the API.
 */
export function sanitizeTemplateParam(value, maxLen = 900) {
  let text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text;
}

async function watiFetch(baseUrl, token, path, body, method) {
  const httpMethod = method || (body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`${baseUrl}${path}`, {
    method: httpMethod,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // Bounded: a slow WATI must never hold the admin request open.
    signal: AbortSignal.timeout(10_000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text?.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, json };
}

/**
 * WATI answers 200 with `result: false` for a bad number, so HTTP status alone
 * is not enough to call a send successful.
 */
export function parseWatiSendResult({ ok, status, json }) {
  const info = String(json?.info || json?.message || json?.error || '').trim();
  const notWhatsapp = json?.validWhatsAppNumber === false;
  const explicitFail = json?.result === false
    || notWhatsapp
    || /undeliverable|invalid phone|not a valid|failed|error/i.test(info);
  if (!ok || explicitFail) {
    // WATI often rejects a number with a bare `result: false` and no message.
    // "WATI send failed (200)" told an admin nothing; naming the actual cause
    // is what points them at the team member whose number needs fixing.
    let error = info;
    if (!error) {
      if (notWhatsapp) error = 'not a WhatsApp number';
      else if (json?.result === false) error = 'rejected by WATI (number not on WhatsApp, or not reachable)';
      else error = `WATI send failed (${status})`;
    }
    return { success: false, error, response: json };
  }
  return { success: true, response: json, messageId: json?.messageId || json?.whatsappMessageId || null };
}

export async function watiEnsureContact(baseUrl, token, phone, name) {
  try {
    const { json } = await watiFetch(baseUrl, token, '/api/v1/addContact', {
      name: name || 'Fulfilment',
      phoneNumber: phone,
      allowBroadcast: true,
    });
    return json;
  } catch {
    // A contact that already exists is not an error worth failing the send for.
    return null;
  }
}

/**
 * Send the new-order template.
 *
 * Body (template `order_received_team`, category UTILITY, no buttons):
 *   New order received
 *   Order from {{1}}
 *   Fulfilment link {{2}}
 *
 * WATI names custom params positionally — `name` is the number, not a word.
 */
export async function watiSendNewOrder(baseUrl, token, phone, { customerName, fulfillmentUrl }) {
  const parameters = [
    { name: '1', value: sanitizeTemplateParam(customerName, 120) },
    { name: '2', value: sanitizeTemplateParam(fulfillmentUrl, 900) },
  ];
  const { ok, status, json } = await watiFetch(
    baseUrl,
    token,
    `/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`,
    {
      template_name: NEW_ORDER_TEMPLATE,
      broadcast_name: NEW_ORDER_TEMPLATE,
      parameters,
    },
  );
  return parseWatiSendResult({ ok, status, json });
}
