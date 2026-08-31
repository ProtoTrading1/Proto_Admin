import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const endpoint = fs.readFileSync(new URL('../api/email-unsubscribes.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../src/components/EmailUnsubscribesPanel.jsx', import.meta.url), 'utf8');
const comms = fs.readFileSync(new URL('../src/components/CommsPanel.jsx', import.meta.url), 'utf8');

describe('email unsubscribe admin tab', () => {
  it('exposes a protected API for marketing opt-outs', () => {
    expect(endpoint).toContain('requireAdminKey(req, res)');
    expect(endpoint).toContain("from('marketing_email_opt_outs')");
    expect(endpoint).toContain('listBrevoSuppressedContacts');
    expect(endpoint).toContain('suppressBrevoContact');
    expect(endpoint).toContain('customersByEmail');
  });

  it('adds the unsubscribe tab inside Email CRM', () => {
    expect(comms).toContain("const EmailUnsubscribesPanel = lazyRetry(() => import('./EmailUnsubscribesPanel'))");
    expect(comms).toContain("setTab('unsubscribed')");
    expect(comms).toContain('<EmailUnsubscribesPanel onShowToast={onShowToast} />');
  });

  it('shows searchable opt-out records without a send action', () => {
    expect(panel).toContain('/api/email-unsubscribes?');
    expect(panel).toContain('Search email');
    expect(panel).toContain('Unsubscribed');
    expect(panel).toContain('Business');
    expect(panel).toContain('Contact');
    expect(panel).not.toContain('Send now');
  });

  it('allows Catherine to unsubscribe a contact directly from Email CRM', () => {
    expect(comms).toContain("fetch('/api/email-unsubscribes'");
    expect(comms).toContain('unsubscribeContact(email)');
    expect(comms).toContain('Stop marketing emails for this contact');
    expect(comms).toContain('Unsubscribe</span>');
  });
});


