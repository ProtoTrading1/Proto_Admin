import { describe, expect, it } from 'vitest';
import { formatSyncWarning } from '../api/_ensure-product.js';

describe('formatSyncWarning', () => {
  it('formats a Supabase-style error object as "step: message"', () => {
    expect(formatSyncWarning('upsert_website_product_from_stock', { message: 'permission denied' }))
      .toBe('upsert_website_product_from_stock: permission denied');
  });

  it('accepts a plain string error', () => {
    expect(formatSyncWarning('sync_website_from_products', 'timeout'))
      .toBe('sync_website_from_products: timeout');
  });

  it('falls back to "unknown error" when the error carries no message', () => {
    expect(formatSyncWarning('sync_website_from_products', null))
      .toBe('sync_website_from_products: unknown error');
    expect(formatSyncWarning('sync_website_from_products', { message: '   ' }))
      .toBe('sync_website_from_products: unknown error');
  });
});
