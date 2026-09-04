import { describe, expect, it } from 'vitest';
import { extractProductCode } from '../src/lib/apolloConversation.js';
import { apolloSectionForFocus } from '../src/lib/apolloOperations.js';

describe('Apollo distinguishes product codes from business figures', () => {
  it('opens Site Content for a website-content answer even when product intelligence also matched', () => {
    expect(apolloSectionForFocus('site_content', ['product_intelligence', 'site_content'])).toBe('site-content');
  });
  it.each([
    'Orders on 2026-08-30', 'Sales on 30/08/2026', 'Sales above R100000',
    'Orders above R 10000', 'Sales above $10000', 'Orders above 10000.50',
    '10000 club customers', 'Show 10000 orders', 'Stock below 10000000',
    'How are sales today?', 'Show the last 14 days',
  ])('does not route %s to a product lookup', (question) => {
    expect(extractProductCode(question)).toBe('');
  });
  it.each([
    ['8630330015', '8630330015'], ['10000', '10000'], ['LS15B', 'LS15B'],
    ['Tell me about code 8610100040n.', '8610100040N'], ['SKU: LS15B', 'LS15B'],
    ['SKU R10000', 'R10000'], ['code AB-12/3', 'AB-12/3'],
    ['Stock for 8630330015', '8630330015'], ['Show product LS15B', 'LS15B'],
  ])('preserves intentional lookup %s', (question, code) => {
    expect(extractProductCode(question)).toBe(code);
  });
});
