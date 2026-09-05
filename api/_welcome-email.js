import { PROTO_URLS } from './_proto-urls.js';
import {
  buildRecipientVars,
  sendBrevoTransactional,
  wrapBroadcastHtml,
} from './_brevo-email.js';
import { markCustomerEmailed } from './_customer-email-status.js';

/**
 * Welcome / approval email — sent when a customer is approved (including the
 * automatic "10000 club" approval at sign-up). Confirms trade access and links
 * to the trade portal. No customer code is mentioned (codes are allocated
 * manually later).
 */

export const WELCOME_SUBJECT = 'Welcome to Proto Trading — your trade account is approved';

export function buildWelcomeEmail(recipient = {}, { needsPasswordSetup = false } = {}) {
  const vars = buildRecipientVars(recipient);
  const greetingName = vars.first_name || vars.contact_name || vars.business_name || 'there';
  // Customer-facing link → proto.co.za (never the API-base `site` origin).
  const site = PROTO_URLS.publicSite;
  // Manually-added customers have no password yet — point them at "Forgot
  // password" so they can set one. Self-registered members already have one.
  const passwordHtml = needsPasswordSetup
    ? `<p style="margin:0 0 20px;line-height:1.55;">To sign in the first time, use <strong>Forgot password</strong> at the portal to set your password (your email is <strong>${escapeHtml(vars.email)}</strong>).</p>`
    : '';
  const passwordText = needsPasswordSetup
    ? `\nTo sign in the first time, use "Forgot password" at the portal to set your password (your email is ${vars.email}).\n`
    : '';
  const bodyHtml = `
    <p style="margin:0 0 14px;line-height:1.55;">Hi ${escapeHtml(greetingName)},</p>
    <p style="margin:0 0 14px;line-height:1.55;">
      Great news — your Proto Trading account has been approved and you now have access to our
      wholesale trade portal. You can browse the full catalogue, see your trade pricing and place
      orders online.
    </p>
    <p style="margin:0 0 20px;line-height:1.55;">
      Sign in any time at <a href="${site}" style="color:#8B1A1A;font-weight:700;">${site.replace(/^https?:\/\//, '')}</a>.
    </p>
    ${passwordHtml}
    <p style="margin:0 0 24px;">
      <a href="${site}" style="display:inline-block;background:#8B1A1A;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">Shop the trade portal</a>
    </p>
    <p style="margin:0;line-height:1.55;color:#6b7280;font-size:13px;">
      If you have any questions just reply to this email — we're happy to help.
    </p>`;
  const htmlContent = wrapBroadcastHtml({ subject: WELCOME_SUBJECT, bodyHtml });
  const textContent = `Hi ${greetingName},\n\nYour Proto Trading account has been approved — you now have access to the wholesale trade portal at ${site}.\n${passwordText}\nBrowse the catalogue, see your trade pricing and order online.\n\nQuestions? Just reply to this email.`;
  return { subject: WELCOME_SUBJECT, htmlContent, textContent };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send the welcome/approval email to a customer. Best-effort: returns
 * { sent, messageId } and never throws into the approval flow. When `supabase`
 * is supplied the customer's last-email status is stamped.
 */
export async function sendWelcomeApprovalEmail(recipient, { supabase = null, needsPasswordSetup = false } = {}) {
  const email = String(recipient?.email || '').trim();
  if (!email) return { sent: false, reason: 'no_email' };
  const { subject, htmlContent, textContent } = buildWelcomeEmail(recipient, { needsPasswordSetup });
  const name = recipient.contact_name || recipient.name || recipient.business_name || email;
  const body = await sendBrevoTransactional({ to: { email, name }, subject, htmlContent, textContent });
  const messageId = body?.messageId || body?.['message-id'] || (Array.isArray(body?.messageIds) ? body.messageIds[0] : null);
  if (supabase) {
    await markCustomerEmailed(supabase, { id: recipient.id || null, email, type: 'welcome' });
  }
  return { sent: true, messageId: messageId || null };
}
