import { requireAdminKey } from './_admin-auth.js';
import {
  buildComposedEmail,
  sendBrevoTransactional,
  wrapBroadcastHtml,
  TEST_MERGE_VARS,
} from './_brevo-email.js';
import { buildWelcomeEmail } from './_welcome-email.js';
import { buildTradeApplicationEmail } from '../lib/trade-application-email.mjs';

/**
 * Send a TEST copy of any email template to the admin (or any address they
 * enter), using sample data. Lets each email option be previewed in a real
 * inbox before it goes to customers.
 *
 * POST { template: 'welcome'|'campaign'|'order_confirmation'|'trade_application',
 *        to, subject?, introText?, htmlBlock? }
 */

function sampleOrderConfirmationEmail() {
  const bodyHtml = `
    <h2 style="margin:0 0 10px;color:#8B1A1A;">Order Confirmation — #SAMPLE-1024</h2>
    <p style="margin:0 0 14px;line-height:1.55;">Hi Jane, thanks for your order. Here's a summary:</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px;">
      <tr><td style="padding:6px 0;border-bottom:1px solid #eee;">2 × Leather Pencil Bag (LSL36)</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">R150.00</td></tr>
      <tr><td style="padding:6px 0;border-bottom:1px solid #eee;">10 × A4 Board (BRD021)</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">R1,950.00</td></tr>
      <tr><td style="padding:8px 0;font-weight:800;">Total (incl. VAT)</td><td style="padding:8px 0;text-align:right;font-weight:800;">R2,100.00</td></tr>
    </table>
    <p style="margin:0;color:#6b7280;font-size:13px;">The real email attaches the order confirmation PDF. This is a sample for testing.</p>`;
  return {
    subject: '[TEST] Your Order Confirmation SAMPLE-1024 — Proto Trading',
    htmlContent: wrapBroadcastHtml({ subject: 'Order Confirmation', bodyHtml }),
    textContent: 'Sample order confirmation (the real email includes the PDF).',
  };
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const template = String(req.body?.template || '').trim();
  const to = String(req.body?.to || '').trim().toLowerCase();
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'A valid recipient email is required' });
  if (!process.env.BREVO_API_KEY) return res.status(503).json({ error: 'BREVO_API_KEY is not configured' });

  const sampleVars = { ...TEST_MERGE_VARS, email: to };
  let msg;

  if (template === 'welcome') {
    const e = buildWelcomeEmail({ email: to, first_name: TEST_MERGE_VARS.first_name, business_name: TEST_MERGE_VARS.business_name });
    msg = { subject: `[TEST] ${e.subject}`, htmlContent: e.htmlContent, textContent: e.textContent };
  } else if (template === 'trade_application') {
    const e = buildTradeApplicationEmail({ email: to, name: TEST_MERGE_VARS.name, businessName: TEST_MERGE_VARS.business_name });
    msg = { subject: `[TEST] ${e.subject}`, htmlContent: e.html, textContent: e.text };
  } else if (template === 'order_confirmation') {
    msg = sampleOrderConfirmationEmail();
  } else if (template === 'campaign') {
    const subject = String(req.body?.subject || 'Sample campaign').trim();
    const introText = String(req.body?.introText || 'This is a sample campaign email.');
    const htmlBlock = String(req.body?.htmlBlock || '');
    const c = buildComposedEmail({ subject, introText, htmlBlock }, sampleVars);
    msg = { subject: `[TEST] ${c.subject}`, htmlContent: c.htmlContent, textContent: c.textContent };
  } else {
    return res.status(400).json({ error: `Unknown template: ${template || '(none)'}` });
  }

  try {
    await sendBrevoTransactional({ to: { email: to, name: 'Proto Test' }, subject: msg.subject, htmlContent: msg.htmlContent, textContent: msg.textContent });
    return res.status(200).json({ ok: true, sent: true, template, to });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Test send failed' });
  }
}
