import { requireAdminKey } from './_admin-auth.js';
import {
  buildComposedEmail,
  buildRecipientVars,
  TEST_MERGE_VARS,
  sendBrevoTransactional,
} from './_brevo-email.js';
import { runEmailBroadcast, VALID_EMAIL_AUDIENCE } from './_send-email-broadcast.js';

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
  maxDuration: 300,
};

/** Send a Brevo email to portal customers (by tab / audience). */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'POST') return res.status(405).end();

  const {
    audience,
    subject,
    introText,
    htmlBlock,
    htmlContent,
    textContent,
    testEmail,
    businessTypes,
    recipients,
    importBatch,
    groupId,
  } = req.body || {};

  // "Specific people" send — an explicit email list instead of an audience.
  const selectedEmails = Array.isArray(recipients)
    ? [...new Set(recipients.map((r) => String(typeof r === 'string' ? r : r?.email || '').trim().toLowerCase()).filter((e) => e.includes('@')))]
    : [];
  const isSelected = String(audience || '').trim() === 'selected' || selectedEmails.length > 0;

  const aud = isSelected ? 'selected' : String(audience || '').trim();
  if (!isSelected && !VALID_EMAIL_AUDIENCE.has(aud)) {
    return res.status(400).json({ error: 'Invalid audience. Use approved trade customers or a group.' });
  }
  if (aud === 'group' && !String(groupId || '').trim()) {
    return res.status(400).json({ error: 'Choose a group to send to.' });
  }
  if (isSelected && !testEmail && !selectedEmails.length) {
    return res.status(400).json({ error: 'Enter at least one valid email address to send to specific people.' });
  }
  const subj = String(subject || '').trim();
  if (!subj) return res.status(400).json({ error: 'Subject is required' });

  const intro = String(introText ?? '').trim();
  const html = String(htmlBlock ?? htmlContent ?? '').trim();
  if (!intro && !html && !textContent) {
    return res.status(400).json({ error: 'Write a message body and/or HTML block.' });
  }

  try {
    if (testEmail) {
      const to = { email: String(testEmail).trim().toLowerCase(), name: 'Test' };
      const testVars = {
        ...TEST_MERGE_VARS,
        ...buildRecipientVars(to),
        name: TEST_MERGE_VARS.name,
        first_name: TEST_MERGE_VARS.first_name,
        contact_name: TEST_MERGE_VARS.contact_name,
        business_name: TEST_MERGE_VARS.business_name,
      };
      const composed = buildComposedEmail(
        { subject: subj, introText: intro, htmlBlock: html },
        testVars,
      );
      await sendBrevoTransactional({
        to,
        subject: `[TEST] ${composed.subject}`,
        htmlContent: composed.htmlContent,
        textContent: composed.textContent || textContent,
      });
      return res.status(200).json({ ok: true, test: true, sent: 1 });
    }

    const outcome = await runEmailBroadcast({
      audience: aud,
      subject: subj,
      introText: intro,
      htmlBlock: html,
      businessTypes: Array.isArray(businessTypes) ? businessTypes : [],
      importBatch: String(importBatch || '').trim(),
      groupId: String(groupId || '').trim(),
      recipients: isSelected ? selectedEmails : null,
    });
    if (outcome.error && !outcome.total) {
      return res.status(400).json({ error: outcome.error });
    }

    return res.status(outcome.failed ? 207 : 200).json({
      ok: outcome.failed === 0,
      audience: aud,
      total: outcome.total,
      sent: outcome.sent,
      failed: outcome.failed,
      errors: outcome.errors,
    });
  } catch (err) {
    console.error('customer-email-broadcast:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Broadcast failed' });
  }
}
