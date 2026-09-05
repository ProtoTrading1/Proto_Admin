import { describe, expect, it } from 'vitest';
import { parseCustomerTab } from '../api/_admin-query-params.js';

describe('customer application hold contract', () => {
  it('accepts the separate on-hold review queue', () => {
    expect(parseCustomerTab('on-hold')).toBe('on-hold');
  });

  it('still rejects unknown customer queues', () => {
    expect(() => parseCustomerTab('maybe-later')).toThrow(/Invalid tab/);
  });
});
