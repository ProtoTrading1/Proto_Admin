import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enrichCampaignsWithApprovals } from '../lib/campaign-approval-attribution.mjs';

describe('email campaign approval attribution', () => {
  it('separates approved recipients from approvals after the send', () => {
    const [campaign] = enrichCampaignsWithApprovals([{
      id: 'campaign-1',
      sentAt: '2026-09-04T07:08:00.000Z',
      sent: 100,
      recipientEmails: ['NEW@EXAMPLE.COM', 'old@example.com', 'pending@example.com'],
    }], [
      { email: 'new@example.com', is_approved: true, approved_at: '2026-09-04T08:00:00.000Z', approved_at_inferred: false },
      { email: 'old@example.com', is_approved: true, approved_at: '2026-09-01T08:00:00.000Z', approved_at_inferred: false },
      { email: 'pending@example.com', is_approved: false },
    ]);

    expect(campaign.approvalMetrics.approvedNow).toBe(2);
    expect(campaign.approvalMetrics.approvedAfterSend).toBe(1);
    expect(campaign.approvalMetrics.confirmedAfterSend).toBe(1);
    expect(campaign.approvalMetrics.estimatedAfterSend).toBe(0);
    expect(campaign.approvalMetrics.conversionRate).toBe(1);
    expect(campaign.approvalMetrics.convertedCustomers[0].email).toBe('new@example.com');
  });

  it('labels historical created-at backfill as estimated', () => {
    const [campaign] = enrichCampaignsWithApprovals([{
      sentAt: '2026-09-04T07:08:00.000Z',
      sent: 20,
      recipientEmails: ['lead@example.com'],
    }], [{
      email: 'lead@example.com',
      is_approved: true,
      created_at: '2026-09-04T07:30:00.000Z',
      approved_at: '2026-09-04T07:30:00.000Z',
      approved_at_inferred: true,
    }]);

    expect(campaign.approvalMetrics.approvedAfterSend).toBe(1);
    expect(campaign.approvalMetrics.confirmedAfterSend).toBe(0);
    expect(campaign.approvalMetrics.estimatedAfterSend).toBe(1);
  });

  it('does not claim attribution for legacy campaigns without recipient snapshots', () => {
    const [campaign] = enrichCampaignsWithApprovals([{ id: 'legacy', sent: 50 }], []);
    expect(campaign.approvalMetrics.available).toBe(false);
    expect(campaign.approvalMetrics.approvedAfterSend).toBe(0);
  });

  it('credits an approval only to the latest campaign received before approval', () => {
    const campaigns = enrichCampaignsWithApprovals([
      { id: 'older', sentAt: '2026-09-01T08:00:00.000Z', sent: 10, recipientEmails: ['lead@example.com'] },
      { id: 'latest', sentAt: '2026-09-03T08:00:00.000Z', sent: 10, recipientEmails: ['lead@example.com'] },
    ], [{
      email: 'lead@example.com',
      is_approved: true,
      approved_at: '2026-09-04T08:00:00.000Z',
      approved_at_inferred: false,
    }]);

    expect(campaigns[0].approvalMetrics.approvedAfterSend).toBe(0);
    expect(campaigns[1].approvalMetrics.approvedAfterSend).toBe(1);
    expect(campaigns[0].approvalMetrics.approvedNow).toBe(1);
    expect(campaigns[1].approvalMetrics.approvedNow).toBe(1);
  });

  it('wires the secured API, analytics UI, and migration together', () => {
    const api = fs.readFileSync(new URL('../api/email-campaigns.js', import.meta.url), 'utf8');
    const ui = fs.readFileSync(new URL('../src/components/EmailAnalyticsPanel.jsx', import.meta.url), 'utf8');
    const migration = fs.readFileSync(new URL('../migrations/065_customer_approval_attribution.sql', import.meta.url), 'utf8');

    expect(api).toContain('requireAdminKey');
    expect(api).toContain('enrichCampaignsWithApprovals');
    expect(api).toContain(".eq('is_approved', true)");
    expect(ui).toContain('Approved after send');
    expect(ui).toContain("label: 'Approved customers'");
    expect(ui).toContain("label: 'Approved after campaign'");
    expect(ui).toContain('Historical approvals backfilled');
    expect(migration).toContain('approved_at_inferred');
    expect(migration).toContain('before insert or update on public.customers');
    expect(migration).not.toContain('security definer');
  });
});
