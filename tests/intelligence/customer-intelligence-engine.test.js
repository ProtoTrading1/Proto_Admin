import { describe, expect, it } from 'vitest';
import { buildCustomerIntelligence } from '../../src/lib/customerIntelligenceEngine.js';

const now = '2026-08-03T12:00:00.000Z';

describe('customer intelligence engine', () => {
  it('exposes transparent evidence components and never makes an approval decision', () => {
    const result = buildCustomerIntelligence({
      customer: {
        business_name: 'Cape Gifts',
        email: 'buyer@example.test',
        phone: '0210000000',
        product_categories: ['Gift shop'],
        sales_channels: ['Physical retail store'],
        business_description: 'We sell gifts to tourists.',
        claimed_customer_code: 'OLD123',
      },
      now,
    });

    expect(result.contractVersion).toBe('customer-intelligence.v1');
    expect(result.decisionSafety).toEqual(expect.objectContaining({
      automatedApproval: false,
      humanReviewRequired: true,
    }));
    expect(result.scores.traderConfidence.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'business_nature', points: 20, maximum: 20 }),
    ]));
    expect(result.scores.traderConfidence.limitations.join(' ')).toContain('unverified');
  });

  it('does not mislabel missing order history as poor engagement', () => {
    const result = buildCustomerIntelligence({
      customer: { is_approved: true, business_name: 'New Store' },
      now,
    });

    expect(result.scores.engagementHealth).toMatchObject({
      score: null,
      band: 'insufficient_data',
    });
    expect(result.nextBestAction.key).toBe('support_first_order');
  });

  it('recommends a staff-reviewed reconnection for a dormant approved customer', () => {
    const result = buildCustomerIntelligence({
      customer: {
        is_approved: true,
        customer_code: 'C100',
        product_categories: ['Stationery', 'Gifts'],
        sales_channels: ['Retail store'],
      },
      orderSummary: {
        orderCount: 8,
        recordedSales: 72000,
        salesPeriodLabel: '2025/26 financial year sales',
        salesSnapshot: true,
        averageOrderValue: 9000,
        lastOrderDate: '2026-02-01T00:00:00.000Z',
        ordersLast90Days: 0,
        salesTrendPercent: -35,
      },
      now,
    });

    expect(result.nextBestAction).toMatchObject({
      key: 'reconnect_inactive',
      priority: 'high',
    });
    expect(result.nextBestAction.reason).toContain('183 days');
    expect(result.scores.customerPotential.reasons.join(' ')).toMatch(/R72\s000 in 2025\/26 financial year sales/);
    expect(result.scores.customerPotential.limitations.join(' ')).toContain('imported financial-year snapshot');
  });

  it('keeps customer-stated spend visible as a limitation', () => {
    const result = buildCustomerIntelligence({
      customer: { monthly_spend: 'R25,000 – R50,000' },
      now,
    });

    expect(result.scores.customerPotential.components.find((item) => item.key === 'stated_spend'))
      .toMatchObject({ points: 24, maximum: 30 });
    expect(result.scores.customerPotential.limitations.join(' ')).toContain('customer supplied');
  });

  it('records the exact evidence scope and avoids external inference', () => {
    const result = buildCustomerIntelligence({ customer: {}, orderSummary: {}, now });

    expect(result.evidenceScope).toEqual(expect.objectContaining({
      customerApplicationIncluded: false,
      orderSummaryIncluded: false,
    }));
    expect(result.evidenceScope.limitations.join(' ')).toContain('No web, social-media, credit or demographic inference');
  });
});
