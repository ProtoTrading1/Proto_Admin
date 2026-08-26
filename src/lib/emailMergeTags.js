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

export function applyMergeTags(template, vars = {}) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/gi, (_, key) => {
    const value = vars[String(key).toLowerCase()];
    return value != null ? String(value) : '';
  });
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

export function buildEmailBodyHtml({ introText = '', htmlBlock = '' }, vars = {}) {
  const intro = introText.trim();
  const html = htmlBlock.trim();
  const introHtml = intro ? plainToHtml(applyMergeTags(intro, vars)) : '';
  const htmlPart = html ? stripDangerousHtml(applyMergeTags(html, vars)) : '';
  return [introHtml, htmlPart].filter(Boolean).join('\n');
}

export function buildEmailTextContent({ introText = '', htmlBlock = '' }, vars = {}) {
  const parts = [];
  if (introText.trim()) parts.push(applyMergeTags(introText, vars));
  if (htmlBlock.trim()) parts.push(htmlToText(applyMergeTags(htmlBlock, vars)));
  return parts.join('\n\n').trim();
}

export function wrapBroadcastHtml({ subject, bodyHtml, siteUrl = 'https://proto.co.za' }) {
  const safeBody = bodyHtml || '<p style="color:#9ca3af;">Your message will appear here.</p>';
  // Keep in sync with api/_brevo-email.js wrapBroadcastHtml (the sent version).
  // No footer/button — the email ends with the composed body.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(subject || 'Email preview')}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
  ${safeBody}
</body></html>`;
}
