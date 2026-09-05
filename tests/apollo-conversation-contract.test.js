import { describe, expect, it } from 'vitest';
import { buildBoundedContext, planApolloSources, prepareApolloQuestion } from '../src/lib/apolloConversation.js';
import { normalizeApolloRequest } from '../api/codex-analytics-jobs.js';

describe('Apollo conversational contract', () => {
  it('preserves the exact question and plans every explicitly requested source', () => {
    const question = 'Compare orders with products customers viewed this week.';
    const prepared = prepareApolloQuestion(question);
    expect(prepared).toMatchObject({ ok: true, question, mode: 'read_only' });
    expect(prepared.sourcePlan).toEqual(expect.arrayContaining(['orders', 'customer_attention']));
  });

  it('bounds and redacts conversation context', () => {
    const turns = Array.from({ length: 7 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index} george@example.com +27 82 123 4567 ${'x'.repeat(400)}`,
      sourcePlan: ['orders'],
    }));
    const result = buildBoundedContext(turns);
    expect(result).toHaveLength(4);
    expect(result.every((turn) => turn.content.length <= 280)).toBe(true);
    expect(result.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result)).not.toContain('george@example.com');
    expect(JSON.stringify(result)).not.toContain('82 123 4567');
  });

  it('asks for clarification instead of guessing an ungrounded follow-up', () => {
    expect(prepareApolloQuestion('Why did that change?')).toMatchObject({ ok: false });
    const context = [{ role: 'assistant', content: 'Orders decreased.', sourcePlan: ['orders'] }];
    expect(planApolloSources('Why did that change?', context)).toEqual(['orders']);
  });

  it.each([
    'Delete that product',
    'Send an email to the customer',
    'Show the customer phone number',
    'Give me the customer street address',
    'What did customer Acme Traders view?',
    'Check 22 Long Street for me',
  ])('blocks writes or personal-data requests before transport: %s', (question) => {
    expect(prepareApolloQuestion(question).ok).toBe(false);
  });

  it('validates the same bounds at the server boundary', () => {
    const request = normalizeApolloRequest({
      mode: 'read_only',
      question: 'What changed in orders?',
      context: [{ role: 'assistant', content: 'Prior order summary.', sourcePlan: ['orders'] }],
      sourcePlan: ['orders'],
    });
    expect(request.question).toBe('What changed in orders?');
    expect(() => normalizeApolloRequest({ mode: 'read_only', question: 'x', context: [], sourcePlan: [] })).toThrow(/source/i);
    expect(() => normalizeApolloRequest({ mode: 'write', question: 'x', context: [], sourcePlan: ['orders'] })).toThrow(/read-only/i);
    expect(() => normalizeApolloRequest({ mode: 'read_only', question: 'Send this report', context: [], sourcePlan: ['orders'] })).toThrow(/read-only/i);
    expect(() => normalizeApolloRequest({ mode: 'read_only', question: 'Check george@example.com', context: [], sourcePlan: ['orders'] })).toThrow(/personal/i);
    expect(() => normalizeApolloRequest({ mode: 'read_only', question: 'Check orders', context: [{ role: 'user', content: '+27 82 123 4567', sourcePlan: ['orders'] }], sourcePlan: ['orders'] })).toThrow(/personal/i);
  });

  it('allows aggregate company and customer analytics wording', () => {
    expect(prepareApolloQuestion('How is company performance this month?').ok).toBe(true);
    expect(prepareApolloQuestion('How many customer orders were placed?').ok).toBe(true);
  });
});
