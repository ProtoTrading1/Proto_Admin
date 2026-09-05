import { describe, expect, it } from 'vitest';
import { businessSearchUrl, traderVerificationSummary } from '../src/lib/traderVerification.js';

describe('trader application evidence summary', () => {
  it('treats genuine Proto purchase history as the strongest evidence', () => {
    const result = traderVerificationSummary({
      sales_last_12_months: 84600,
      invoice_count: 23,
      business_type: 'Retail store',
      website: 'https://example.co.za',
      email: 'buyer@example.co.za',
      phone: '0210000000',
    });
    expect(result.recommendation).toBe('Likely existing Proto customer');
    expect(result.evidence[0].label).toBe('Proto history found');
  });

  it('does not treat a missing social profile as a decline reason', () => {
    const result = traderVerificationSummary({ business_type: 'Market trader / spaza shop' });
    expect(result.recommendation).toBe('Manual review needed');
    expect(result.evidence).toContainEqual(expect.objectContaining({ detail: expect.stringContaining('not a reason to decline') }));
  });

  it('uses the applicant description as review evidence without auto-approval', () => {
    const result = traderVerificationSummary({
      sales_channels: ['Physical retail store', 'Online shop / e-commerce'],
      product_categories: ['Gifts & novelty products'],
      business_description: 'We sell gifts from a market stall to walk-in customers.',
    });
    expect(result.recommendation).toBe('Trader evidence supplied');
    expect(result.evidence).toContainEqual(expect.objectContaining({
      label: 'Business description supplied',
      detail: expect.stringContaining('market stall'),
    }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ label: 'How they trade' }));
    expect(result.evidence).toContainEqual(expect.objectContaining({ label: 'What they sell' }));
    expect(result).not.toHaveProperty('approved');
    expect(result).not.toHaveProperty('confidence');
  });

  it('keeps a claimed old code separate and asks staff to verify it', () => {
    const result = traderVerificationSummary({ claimed_customer_code: 'abc123' });
    expect(result.recommendation).toBe('Verify claimed Proto code');
    expect(result.evidence[0]).toMatchObject({ tone: 'review', detail: expect.stringContaining('ABC123') });
    expect(result).not.toHaveProperty('confidence');
  });

  it('builds a staff research link from business and location', () => {
    expect(businessSearchUrl({ business_name: 'Cape Gifts', city: 'Cape Town' }))
      .toContain('Cape%20Gifts%20Cape%20Town');
  });
});
