import { describe, expect, it } from 'vitest';
import { buildProductAnswer, formatApolloMoney, formatApolloNumber } from '../src/lib/apolloConversation.js';

describe('Apollo product evidence quality', () => {
  it.each([null, undefined, '', '  ', false, true, [], {}, NaN, Infinity])('does not convert missing or invalid evidence %j to zero', (value) => {
    expect(formatApolloNumber(value)).toBe('Not available');
    expect(formatApolloMoney(value)).toBe('Not available');
  });
  it('preserves genuine zero and numeric source strings', () => {
    expect(formatApolloNumber(0, ' units')).toBe('0 units');
    expect(formatApolloNumber('12', ' units')).toBe('12 units');
    expect(formatApolloMoney('0')).not.toBe('Not available');
  });
  it('describes missing data without claiming zero stock or high confidence', () => {
    const answer = buildProductAnswer({ erp: { availableStock: null }, website: { availableStock: null } }, '8630330015');
    expect(answer.code).toBe('8630330015');
    expect(answer.summary).toContain('available stock could not be verified');
    expect(answer.summary).not.toContain('0 units');
    expect(answer.stockDifference).toBeNull();
    expect(answer.confidence).toBe('Needs checking');
    expect(answer.positill.price).toBe('Not available');
  });
  it('identifies website-only stock as incomplete evidence', () => {
    const answer = buildProductAnswer({ erp: { availableStock: '' }, website: { availableStock: 10, price: 7.5, title: 'Lip gloss' }, sources: { website: 'catalogue' } }, '8630330014');
    expect(answer.summary).toContain('10 units recorded as available in the website catalogue');
    expect(answer.summary).toContain('Positill stock is unavailable');
    expect(answer.stockDifference).toBeNull();
    expect(answer.confidence).toBe('Needs checking');
  });
  it('flags disagreements and cached evidence', () => {
    const product = { erp: { availableStock: 8, price: 7.5 }, website: { availableStock: 10, price: 7.5 }, sources: { erp: 'erp_sql', website: 'catalogue' } };
    expect(buildProductAnswer(product, '8630330014').confidence).toBe('Needs checking');
    product.website.availableStock = 8;
    expect(buildProductAnswer(product, '8630330014').confidence).toBe('High');
    product.sources.erp = 'stmast_cache';
    expect(buildProductAnswer(product, '8630330014').confidence).toBe('Needs checking');
  });
});
