import { createClient } from '@supabase/supabase-js';
import { fetchCustomerAudience, fetchRecipientsByEmail, sendBroadcastBatch } from './_brevo-email.js';
import { appendEmailCampaign } from './_email-campaigns.js';
import { markCustomersEmailed, markCrmContactsEmailed } from './_customer-email-status.js';

export const VALID_EMAIL_AUDIENCE = new Set(['requests', 'regular', 'proto-active', 'all-portal', 'all-approved', 'selected', 'group']);

export function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Resolve the audience, send the personalized broadcast, and log the
 * campaign. Shared by the live send endpoint and the scheduled-send cron.
 */
export async function runEmailBroadcast({ audience, subject, introText = '', htmlBlock = '', businessTypes = [], importBatch = '', groupId = '', recipients: recipientEmails = null }) {
  const sb = getPortalDbClient();
  // Explicit recipient list ("Specific people") bypasses audience resolution.
  const useSelected = Array.isArray(recipientEmails) && recipientEmails.length > 0;
  const recipients = useSelected
    ? await fetchRecipientsByEmail(sb, recipientEmails.map((r) => (typeof r === 'string' ? r : r?.email)))
    : await fetchCustomerAudience(sb, audience, {
      businessTypes: Array.isArray(businessTypes) ? businessTypes : [],
      importBatch,
      groupId,
    });
  if (!recipients.length) {
    return {
      ok: false,
      sent: 0,
      failed: 0,
      total: 0,
      error: useSelected
        ? 'No valid email addresses in the list.'
        : 'No customers with valid email addresses in this audience.',
    };
  }

  const { sent, failed, errors, failedEmails, messageIds } = await sendBroadcastBatch(recipients, {
    subject,
    introText,
    htmlBlock,
  });
  const failedRecipientEmails = new Set((failedEmails || []).filter(Boolean));
  const attemptedRecipientEmails = recipients
    .map((recipient) => String(recipient.email || '').trim().toLowerCase())
    .filter(Boolean);
  const successfulRecipientEmails = attemptedRecipientEmails
    .filter((email) => !failedRecipientEmails.has(email));
  const sentAt = new Date().toISOString();

  try {
    await appendEmailCampaign({
      subject,
      audience,
      businessTypes: Array.isArray(businessTypes) ? businessTypes.filter(Boolean) : [],
      sentAt,
      recipientCount: recipients.length,
      sent,
      failed,
      // Snapshot every attempted recipient so analytics can distinguish
      // failed sends from accepted, delivered, opened, and clicked mail.
      // Event lists alone cannot tell us who did not open a campaign.
      recipientEmails: attemptedRecipientEmails,
      failedRecipientEmails: [...failedRecipientEmails],
      messageIds: messageIds || [],
      events: {},
    });
  } catch (logErr) {
    console.error('runEmailBroadcast: campaign log failed:', logErr?.message || logErr);
  }

  // Stamp the per-customer "last email sent" status (best-effort, analytics only).
  try {
    await Promise.all([
      markCustomersEmailed(sb, successfulRecipientEmails, 'campaign', sentAt),
      markCrmContactsEmailed(sb, successfulRecipientEmails, subject, sentAt),
    ]);
  } catch { /* best effort */ }

  return { ok: failed === 0, total: recipients.length, sent, failed, errors };
}
