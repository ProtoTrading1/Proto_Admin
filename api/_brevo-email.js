import { createHmac, timingSafeEqual } from 'crypto';
import { PROTO_URLS } from './_proto-urls.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(text) {
  return String(text || '')
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return '';
      return `<p style="margin:0 0 14px;line-height:1.55;">${lines.map((line) => escapeHtml(line)).join('<br />')}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function stripDangerousHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function applyMergeTags(template, vars = {}) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/gi, (_, key) => {
    const value = vars[String(key).toLowerCase()];
    return value != null ? String(value) : '';
  });
}

function base64Url(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function getUnsubscribeSecret() {
  return String(
    process.env.MARKETING_UNSUBSCRIBE_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.WEBHOOK_SECRET
    || '',
  ).trim();
}

export function buildUnsubscribeToken(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const secret = getUnsubscribeSecret();
  if (!normalizedEmail || !secret) return '';
  return createHmac('sha256', secret).update(normalizedEmail).digest('base64url');
}

export function verifyUnsubscribeToken(email, token) {
  const expected = buildUnsubscribeToken(email);
  const actual = String(token || '').trim();
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildUnsubscribeUrl(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const token = buildUnsubscribeToken(normalizedEmail);
  if (!normalizedEmail || !token) return '';
  return `${PROTO_URLS.admin}/api/email-unsubscribe?e=${base64Url(normalizedEmail)}&t=${encodeURIComponent(token)}`;
}

export function buildRecipientVars(recipient = {}) {
  const business = recipient.business_name || recipient.name || '';
  const contact = recipient.contact_name || recipient.name || recipient.first_name || '';
  const code = recipient.customer_code || recipient.account_code || '';
  return {
    name: contact || business || recipient.email?.split('@')[0] || '',
    first_name: recipient.first_name || '',
    contact_name: contact,
    business_name: business,
    email: recipient.email || '',
    customer_code: code,
    account_code: recipient.account_code || recipient.customer_code || code,
    phone: recipient.phone || '',
    unsubscribe: recipient.unsubscribe_url || buildUnsubscribeUrl(recipient.email),
    unsubscribe_url: recipient.unsubscribe_url || buildUnsubscribeUrl(recipient.email),
  };
}

export const TEST_MERGE_VARS = {
  name: 'Jane Smith',
  first_name: 'Jane',
  contact_name: 'Jane Smith',
  business_name: 'ABC Stationers',
  email: 'jane@abcstationers.co.za',
  customer_code: 'ABC123',
  account_code: 'ABC123',
  phone: '082 555 1234',
  unsubscribe: `${PROTO_URLS.admin}/api/email-unsubscribe?preview=1`,
  unsubscribe_url: `${PROTO_URLS.admin}/api/email-unsubscribe?preview=1`,
};

export function buildComposedEmail({ subject, introText = '', htmlBlock = '' }, vars = {}) {
  const personalizedSubject = applyMergeTags(subject, vars);
  const intro = introText.trim();
  const html = htmlBlock.trim();
  const introHtml = intro ? plainToHtml(applyMergeTags(intro, vars)) : '';
  const htmlPart = html ? stripDangerousHtml(applyMergeTags(html, vars)) : '';
  const bodyHtml = [introHtml, htmlPart].filter(Boolean).join('\n') || '<p></p>';
  const textContent = buildComposedText({ introText, htmlBlock }, vars);
  const htmlContent = wrapBroadcastHtml({ subject: personalizedSubject, bodyHtml });
  return { subject: personalizedSubject, htmlContent, textContent, bodyHtml };
}

export function buildComposedText({ introText = '', htmlBlock = '' }, vars = {}) {
  const parts = [];
  if (introText.trim()) parts.push(applyMergeTags(introText, vars));
  if (htmlBlock.trim()) parts.push(htmlToText(applyMergeTags(htmlBlock, vars)));
  return parts.join('\n\n').trim();
}

export function wrapBroadcastHtml({ subject, bodyHtml }) {
  const safeBody = bodyHtml || '<p>Hello from Proto Trading.</p>';
  // No footer/button — the email ends with the composed body.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
  ${safeBody}
</body></html>`;
}

export async function sendBrevoTransactional({
  to,
  subject,
  htmlContent,
  textContent,
  attachment,
  headers,
}) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not configured');

  const payload = {
    sender: {
      name: process.env.BREVO_SENDER_NAME || 'Proto Trading',
      email: process.env.BREVO_SENDER_EMAIL || 'online@proto.co.za',
    },
    // Accepts a single recipient or a list. The new-order alert goes to the
    // whole team, and this is the path the cron sweep and the manual resend
    // both use — a single-recipient signature meant only one address could
    // ever be recovered after a failure.
    to: (Array.isArray(to) ? to : [to])
      .filter((entry) => entry && entry.email)
      .map((entry) => ({ email: entry.email, name: entry.name || entry.email })),
    subject,
    htmlContent,
  };
  if (textContent) payload.textContent = textContent;
  if (Array.isArray(attachment) && attachment.length) payload.attachment = attachment;
  if (headers && typeof headers === 'object') payload.headers = headers;

  // Retry on rate-limit (429) and transient 5xx with backoff so a burst of
  // concurrent sends paces itself instead of dropping recipients.
  let resp;
  let body = {};
  for (let attempt = 0; attempt < 5; attempt += 1) {
    resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    body = await resp.json().catch(() => ({}));
    if (resp.ok) break;
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt === 4) break;
    const retryAfter = Number(resp.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (!resp.ok) throw new Error(body.message || `Brevo ${resp.status}`);
  return body;
}

async function fetchAllFromTable(sb, table, buildQuery) {
  const pageSize = 500;
  let page = 0;
  const rows = [];
  while (true) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let q = sb.from(table).select('*').range(from, to);
    if (buildQuery) q = buildQuery(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    page += 1;
    if (page > 200) break;
  }
  return rows;
}

async function fetchOptedOutEmails(sb, emails = []) {
  const wanted = [...new Set(
    (emails || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')),
  )];
  if (!wanted.length) return new Set();
  const optedOut = new Set();
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const { data, error } = await sb
      .from('marketing_email_opt_outs')
      .select('email')
      .in('email', chunk);
    if (error) {
      if (/marketing_email_opt_outs/i.test(error.message || '')) {
        console.warn('marketing_email_opt_outs table is not available; broadcasts cannot filter opt-outs yet.');
        return optedOut;
      }
      throw error;
    }
    (data || []).forEach((row) => {
      const email = String(row.email || '').trim().toLowerCase();
      if (email) optedOut.add(email);
    });
  }
  return optedOut;
}

async function excludeOptedOutRecipients(sb, recipients) {
  const optedOut = await fetchOptedOutEmails(sb, recipients.map((r) => r.email));
  if (!optedOut.size) return recipients;
  return recipients.filter((recipient) => !optedOut.has(String(recipient.email || '').trim().toLowerCase()));
}

function upsertRecipient(seen, row) {
  const email = String(row.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return;
  const prev = seen.get(email) || { email };
  seen.set(email, { ...prev, ...row, email });
}

/**
 * Build recipients for an explicit list of email addresses. Known customers /
 * pre-registration contacts are matched so their merge fields ({{name}} etc.)
 * personalize; unknown addresses still send (name falls back to the local part).
 */
export async function fetchRecipientsByEmail(sb, emails = []) {
  const wanted = [...new Set(
    (emails || []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@')),
  )];
  if (!wanted.length) return [];
  const seen = new Map();

  for (let i = 0; i < wanted.length; i += 200) {
    const chunk = wanted.slice(i, i + 200);
    const { data: custRows } = await sb.from('customers').select('*').in('email', chunk);
    (custRows || []).forEach((r) => upsertRecipient(seen, {
      email: r.email,
      name: r.first_name || r.contact_name || r.name || r.business_name || '',
      first_name: r.first_name || '',
      contact_name: r.contact_name || r.name || '',
      business_name: r.business_name || r.name || '',
      customer_code: r.customer_code || '',
      account_code: r.customer_code || '',
      phone: r.phone || '',
      business_type: r.business_type || '',
    }));
    const { data: protoRows } = await sb.from('proto_active_customers').select('*').in('email', chunk);
    (protoRows || []).forEach((r) => upsertRecipient(seen, {
      email: r.email,
      name: r.first_name || r.contact_name || r.name || '',
      first_name: r.first_name || '',
      contact_name: r.contact_name || '',
      business_name: r.name || '',
      account_code: r.account_code || '',
      customer_code: r.account_code || '',
    }));
  }
  // Any address not on file still gets the email (personalization falls back).
  for (const email of wanted) {
    if (!seen.has(email)) seen.set(email, { email });
  }
  return excludeOptedOutRecipients(sb, [...seen.values()]);
}

export async function fetchCustomerAudience(sb, audience, { businessTypes = [], importBatch = '', groupId = '' } = {}) {
  const seen = new Map();
  const types = [...new Set((businessTypes || []).map((t) => String(t || '').trim()).filter(Boolean))];
  const matchesBusinessType = (row) => {
    if (!types.length) return true;
    const bt = String(row.business_type || '').trim();
    return types.includes(bt);
  };

  if (audience === 'requests' || audience === 'regular' || audience === 'all-portal' || audience === 'all-approved') {
    const portalRows = await fetchAllFromTable(sb, 'customers', (q) => {
      let query = q;
      if (audience === 'requests') query = query.eq('is_approved', false);
      else if (audience === 'regular' || audience === 'all-approved' || audience === 'all-portal') {
        query = query.eq('is_approved', true);
      }
      if (types.length) query = query.in('business_type', types);
      return query;
    });
    portalRows.forEach((r) => {
      if (!matchesBusinessType(r)) return;
      upsertRecipient(seen, {
        email: r.email,
        name: r.first_name || r.contact_name || r.name || r.business_name || '',
        first_name: r.first_name || '',
        contact_name: r.contact_name || r.name || '',
        business_name: r.business_name || r.name || '',
        customer_code: r.customer_code || '',
        account_code: r.customer_code || '',
        phone: r.phone || '',
        business_type: r.business_type || '',
      });
    });
  }

  if (audience === 'proto-active' || audience === 'all-portal') {
    // Narrow to one CSV upload when asked. proto_active_customers carries no
    // business_type, so the batch is the only way to segment this audience.
    const batch = String(importBatch || '').trim();
    const protoRows = await fetchAllFromTable(
      sb,
      'proto_active_customers',
      batch ? (q) => q.eq('import_batch', batch) : undefined,
    );
    protoRows.forEach((r) => {
      if (!matchesBusinessType(r)) return;
      upsertRecipient(seen, {
        email: r.email,
        name: r.first_name || r.contact_name || r.name || '',
        first_name: r.first_name || '',
        contact_name: r.contact_name || '',
        business_name: r.name || '',
        account_code: r.account_code || '',
        customer_code: r.account_code || '',
        business_type: r.business_type || '',
      });
    });
  }

  // A group is a standalone list, not a slice of the customer base: its
  // members are not customers and carry no business_type, so the business-type
  // filter is deliberately not applied here — it would silently empty the
  // audience rather than narrow it.
  if (audience === 'group') {
    const id = String(groupId || '').trim();
    if (!id) return [];
    const memberRows = await fetchAllFromTable(sb, 'email_group_members', (q) => q.eq('group_id', id));
    memberRows.forEach((r) => {
      upsertRecipient(seen, {
        email: r.email,
        name: r.name || r.business_name || '',
        first_name: r.name || '',
        contact_name: r.name || '',
        business_name: r.business_name || '',
        customer_code: '',
        account_code: '',
        phone: '',
        business_type: '',
      });
    });
  }

  return excludeOptedOutRecipients(sb, [...seen.values()]);
}

// Bounded concurrency keeps a 1000-recipient broadcast well inside the 300s
// function ceiling (sequential sends were 3-6+ minutes and timed out).
const BROADCAST_CONCURRENCY = 8;

export async function sendBroadcastBatch(recipients, { subject, introText = '', htmlBlock = '', onProgress }) {
  let sent = 0;
  let failed = 0;
  const errors = [];
  const failedEmails = [];
  const messageIds = [];

  let cursor = 0;
  async function worker() {
    while (cursor < recipients.length) {
      const idx = cursor;
      cursor += 1;
      const recipient = recipients[idx];
      try {
        const vars = buildRecipientVars(recipient);
        const { subject: personalizedSubject, htmlContent, textContent } = buildComposedEmail(
          { subject, introText, htmlBlock },
          vars,
        );
        const result = await sendBrevoTransactional({
          to: { email: recipient.email, name: vars.name || recipient.email },
          subject: personalizedSubject,
          htmlContent,
          textContent,
        });
        const messageId = result?.messageId || result?.['message-id'] || result?.messageIds?.[0];
        if (messageId) messageIds.push(String(messageId));
        sent += 1;
        if (onProgress) onProgress({ sent, failed, total: recipients.length });
      } catch (err) {
        failed += 1;
        failedEmails.push(String(recipient.email || '').trim().toLowerCase());
        if (errors.length < 20) errors.push({ email: recipient.email, error: err.message });
      }
    }
  }

  const workers = Math.min(BROADCAST_CONCURRENCY, recipients.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { sent, failed, errors, failedEmails, messageIds };
}
