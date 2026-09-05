import { describe, expect, it } from 'vitest';
import { buildBuyerRankingAnswer } from '../src/lib/apolloBuyerRanking.js';

describe('Apollo deterministic buyer ranking answer', () => {
  it('answers the exact weekly top-buyer question without a model prompt', () => {
    const answer = buildBuyerRankingAnswer({
      periodDays: 7,
      topCustomersByUnits: [
        { companyName: 'Alpha Traders', units: 35, orders: 2, spendExVat: 1200 },
        { companyName: 'Beta Stores', units: 20, orders: 1, spendExVat: 900 },
      ],
    }, 7);
    expect(answer).toMatchObject({ type: 'buyer_ranking', title: 'Top online buyer', identityHandledLocally: true, periodDays: 7 });
    expect(answer.summary).toContain('Alpha Traders');
    expect(answer.summary).toContain('35 units');
    expect(answer.summary).toContain('last 7 days');
    expect(answer.limitations.join(' ')).toMatch(/not sent to the Codex CLI/i);
  });

  it('does not invent a buyer when there are no valid ranked rows', () => {
    const answer = buildBuyerRankingAnswer({ periodDays: 7, topCustomersByUnits: [] }, 7);
    expect(answer.summary).toMatch(/No customer order requests/i);
    expect(answer.findings).toEqual([]);
  });

  it('ignores malformed and zero-unit rows', () => {
    const answer = buildBuyerRankingAnswer({
      topCustomersByUnits: [
        { companyName: 'Bad Row', units: 'not-a-number', orders: 5 },
        { companyName: 'Valid Shop', units: 4, orders: 1, spendExVat: 50 },
      ],
    }, 7);
    expect(answer.summary).toContain('Valid Shop');
    expect(answer.summary).not.toContain('Bad Row');
  });
});
