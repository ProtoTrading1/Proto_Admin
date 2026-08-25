// The only fields that reliably exist for every customer. One "name" (it
// falls back to the business name, then the email) so it is never blank.
// customer/account codes were removed — they are usually empty (codes are
// allocated manually), so a {{customer_code}} tag rendered blank.
export const MERGE_TAGS = [
  { key: 'name', label: 'Name', sample: 'Jane Smith' },
  { key: 'business_name', label: 'Business name', sample: 'ABC Stationers' },
  { key: 'email', label: 'Email', sample: 'jane@abcstationers.co.za' },
];

export const PREVIEW_MERGE_VARS = Object.fromEntries(
  MERGE_TAGS.map(({ key, sample }) => [key, sample]),
);

// Unsubscribe is not a personalization field: it resolves to markup, and the
// intro block HTML-escapes everything it renders. So it is deliberately held
// back from the normal pass and substituted into the assembled body instead
// (see injectUnsubscribeTags). Without this guard the generic "unknown key ->
// empty string" rule below would silently strip it and ship href="".
export const UNSUBSCRIBE_TAGS = ['unsubscribe', 'unsubscribe_url'];
const RESERVED_TAGS = new Set(UNSUBSCRIBE_TAGS);

export function applyMergeTags(template, vars = {}) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/gi, (match, key) => {
    const name = String(key).toLowerCase();
    if (RESERVED_TAGS.has(name) && vars[name] == null) return match;
    const value = vars[name];
    return value != null ? String(value) : '';
  });
}

/** Per-recipient unsubscribe URL. The address is appended so the destination
 *  page (or mailto) knows who is opting out without a lookup. */
export function buildUnsubscribeUrl(baseUrl, email = '') {
  const base = String(baseUrl || '').trim();
  if (!base) return '';
  const address = String(email || '').trim();
  if (!address) return base;
  const key = base.startsWith('mailto:') ? 'body' : 'email';
  return `${base}${base.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(address)}`;
}

/** Small muted text link — the conventional footer treatment. */
export function buildUnsubscribeLinkHtml(url) {
  if (!url) return '';
  return `<a href="${escapeHtml(url)}" style="color:#9ca3af;font-size:12px;text-decoration:underline;">Unsubscribe</a>`;
}

/**
 * Replace the unsubscribe tags in ALREADY-assembled body HTML. Runs after the
 * intro has been escaped and the HTML block sanitized, so the anchor survives
 * intact in both fields.
 */
export function injectUnsubscribeTags(html, { unsubscribeUrl = '', email = '' } = {}) {
  const url = buildUnsubscribeUrl(unsubscribeUrl, email);
  return String(html ?? '').replace(/\{\{\s*(unsubscribe_url|unsubscribe)\s*\}\}/gi, (_, key) => (
    String(key).toLowerCase() === 'unsubscribe_url' ? escapeHtml(url) : buildUnsubscribeLinkHtml(url)
  ));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function plainToHtml(text) {
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

export function stripDangerousHtml(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

export function htmlToText(html) {
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

export function buildEmailBodyHtml({ introText = '', htmlBlock = '' }, vars = {}, { unsubscribeUrl = '' } = {}) {
  const intro = introText.trim();
  const html = htmlBlock.trim();
  const introHtml = intro ? plainToHtml(applyMergeTags(intro, vars)) : '';
  const htmlPart = html ? stripDangerousHtml(applyMergeTags(html, vars)) : '';
  const body = [introHtml, htmlPart].filter(Boolean).join('\n');
  return injectUnsubscribeTags(body, { unsubscribeUrl, email: vars.email });
}

export function buildEmailTextContent({ introText = '', htmlBlock = '' }, vars = {}, { unsubscribeUrl = '' } = {}) {
  const parts = [];
  if (introText.trim()) parts.push(applyMergeTags(introText, vars));
  if (htmlBlock.trim()) parts.push(htmlToText(applyMergeTags(htmlBlock, vars)));
  const text = parts.join('\n\n').trim();
  // Plain-text alternative gets the bare URL for both tags — an <a> would only
  // be flattened back to its label, leaving "Unsubscribe" with nothing to click.
  const url = buildUnsubscribeUrl(unsubscribeUrl, vars.email);
  return text.replace(/\{\{\s*(?:unsubscribe_url|unsubscribe)\s*\}\}/gi, url);
}

export function wrapBroadcastHtml({ subject, bodyHtml, siteUrl = 'https://proto.co.za' }) {
  const safeBody = bodyHtml || '<p style="color:#9ca3af;">Your message will appear here.</p>';
  // Keep in sync with api/_brevo-email.js wrapBroadcastHtml (the sent version).
  // No automatic footer/button — the email ends with the composed body.
  // An unsubscribe link is opt-in per send via the {{unsubscribe}} tag.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(subject || 'Email preview')}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
  ${safeBody}
</body></html>`;
}
