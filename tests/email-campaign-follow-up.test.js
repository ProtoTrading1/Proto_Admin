import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const analytics = fs.readFileSync(new URL('../src/components/EmailAnalyticsPanel.jsx', import.meta.url), 'utf8');
const broadcast = fs.readFileSync(new URL('../api/_send-email-broadcast.js', import.meta.url), 'utf8');
const batch = fs.readFileSync(new URL('../api/_brevo-email.js', import.meta.url), 'utf8');

describe('email campaign follow-up audiences', () => {
  it('saves successful recipient snapshots for future no-open follow-up lists', () => {
    expect(broadcast).toMatch(/recipientEmails:/);
    expect(broadcast).toMatch(/const failedRecipientEmails = new Set\(\(failedEmails \|\| \[\]\)\.filter\(Boolean\)\)/);
    expect(batch).toMatch(/const failedEmails = \[\];/);
  });

  it('stamps CRM contacts for group broadcasts using only successful recipients', () => {
    expect(broadcast).toContain("markCrmContactsEmailed(sb, successfulRecipientEmails, subject, sentAt)");
    expect(broadcast).toContain("import { markCustomersEmailed, markCrmContactsEmailed }");
  });

  it('provides the five recipient tabs and keeps bounced contacts out of follow-up', () => {
    expect(analytics).toContain("label: 'All recipients'");
    expect(analytics).toContain("label: 'No recorded open'");
    expect(analytics).toContain("label: 'Opened, no click'");
    expect(analytics).toContain("label: 'Clicked'");
    expect(analytics).toContain("label: 'Bounced / excluded'");
    expect(analytics).toMatch(/!activeEmails\.has\(email\)/);
  });

  it('only prepares a follow-up draft and never sends it from analytics', () => {
    expect(analytics).toContain('Create follow-up email');
    expect(analytics).toMatch(/onCompose\?\.\(\{ audience: 'selected', recipients: active\.emails \}\)/);
    expect(analytics).not.toContain('sendCustomerEmailBroadcast');
  });

  it('explains the different CRM scopes to prevent source confusion', () => {
    const comms = fs.readFileSync(new URL('../src/components/CommsPanel.jsx', import.meta.url), 'utf8');
    expect(comms).toContain('Contacts = approved portal customers');
    expect(comms).toContain('Groups = broader saved audiences');
    expect(comms).toContain('Analytics = every logged campaign send');
  });
});
