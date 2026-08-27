import { describe, expect, it } from 'vitest';
import { uppercasePdfCustomerDetails } from '../src/lib/orderDocuments.js';

describe('order PDF customer details', () => {
  it('capitalises every customer and delivery label line without changing the source', () => {
    const details = [
      'Jane Dlamini',
      'Corner Craft Shop',
      '12 Market Street',
      'Cape Town, Western Cape',
      'Email: jane@example.com',
      'Phone: +27 21 555 0199',
    ];

    expect(uppercasePdfCustomerDetails(details)).toEqual([
      'JANE DLAMINI',
      'CORNER CRAFT SHOP',
      '12 MARKET STREET',
      'CAPE TOWN, WESTERN CAPE',
      'EMAIL: JANE@EXAMPLE.COM',
      'PHONE: +27 21 555 0199',
    ]);
    expect(details[0]).toBe('Jane Dlamini');
  });

  it('handles blank and numeric customer fields safely', () => {
    expect(uppercasePdfCustomerDetails(['', null, 8001])).toEqual(['', '', '8001']);
  });
});
