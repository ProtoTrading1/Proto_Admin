import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareApolloQuestion } from '../src/lib/apolloConversation.js';
import { askApolloOperations, classifyApolloQuestion } from '../src/lib/apolloOperations.js';

const exactQuestion = 'who bought the most stock online this week ?';
const equivalentQuestion = 'which customer ordered the most units online this week?';

afterEach(() => vi.unstubAllGlobals());

describe('Apollo top-online-buyer routing', () => {
  it('routes the reported question to week-to-date buyer ranking, not Backend Health', () => {
    expect(classifyApolloQuestion(exactQuestion)).toEqual({ kind: 'buyer_ranking', periodDays: 7, periodKey: 'week_to_date' });
    expect(prepareApolloQuestion(exactQuestion).sourcePlan).toEqual(['orders']);
  });

  it('allows equivalent customer-ranking wording without weakening contact-detail privacy', () => {
    expect(prepareApolloQuestion(equivalentQuestion)).toMatchObject({ ok: true, sourcePlan: ['orders'] });
    expect(classifyApolloQuestion(equivalentQuestion)).toEqual({ kind: 'buyer_ranking', periodDays: 7, periodKey: 'week_to_date' });
    expect(prepareApolloQuestion(`${equivalentQuestion} Give me their email address.`).ok).toBe(false);
    expect(prepareApolloQuestion('What did customer Acme Traders order?').ok).toBe(false);
  });

  it.each([
    'Are all Proto systems healthy?',
    'Is the website online?',
    'Is the bridge down?',
    'Show backend health',
  ])('preserves genuine health routing: %s', (question) => {
    expect(classifyApolloQuestion(question).kind).toBe('health');
  });

  it('uses one authenticated deterministic endpoint and never creates a Codex job', async () => {
    const request = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        window: { label: 'This week' },
        leaders: [{ displayName: 'Alpha Traders', units: 35, orders: 2, valueExVat: 1200 }],
      }),
    }));
    vi.stubGlobal('fetch', request);
    const answer = await askApolloOperations(exactQuestion);
    expect(answer).toMatchObject({ type: 'buyer_ranking', identityHandledLocally: true, sourcePlan: ['orders'] });
    expect(answer.summary).toContain('Alpha Traders');
    expect(answer.summary).toContain('for this week');
    expect(answer.summary).not.toContain('last 7 days');
    expect(answer.periodLabel).toBe('This week');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/apollo-order-leader?window=week_to_date');
    expect(request.mock.calls.some(([url]) => String(url).includes('codex-analytics-jobs'))).toBe(false);
  });
});
