import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { customerDetailRows, customerEmailIdentity } from '../lib/order-format.mjs';

describe('order email customer identity', () => {
  it('shows the customer and company as separate labelled values', () => {
    const customer = {
      name: 'Monique Potgieter',
      contact_name: 'Monique Potgieter',
      business_name: 'Ocean Echo Properties 135 cc',
      email: 'monique@example.co.za',
    };

    expect(customerEmailIdentity(customer)).toEqual({
      customerName: 'Monique Potgieter',
      companyName: 'Ocean Echo Properties 135 cc',
    });
    expect(customerDetailRows({ customers: customer })).toEqual([
      { label: 'Customer', value: 'Monique Potgieter' },
      { label: 'Company', value: 'Ocean Echo Properties 135 cc' },
      { label: 'Email', value: 'monique@example.co.za' },
    ]);
  });

  it('does not duplicate the same value or invent a missing company', () => {
    expect(customerEmailIdentity({ name: 'LOVE ME CREATIONS', business_name: 'LOVE ME CREATIONS' }))
      .toEqual({ customerName: 'LOVE ME CREATIONS', companyName: '' });
    expect(customerEmailIdentity({ contact_name: 'Lisa Pittaway' }))
      .toEqual({ customerName: 'Lisa Pittaway', companyName: '' });
  });

  it('carries both values through customer and internal order email sends', () => {
    const customerSend = readFileSync(new URL('../api/send-order-email.js', import.meta.url), 'utf8');
    const internalSend = readFileSync(new URL('../api/_order-notify-core.js', import.meta.url), 'utf8');

    expect(customerSend).toContain('business_name: companyName');
    expect(internalSend).toContain('<strong>Customer:</strong>');
    expect(internalSend).toContain('<strong>Company:</strong>');
    expect(internalSend).toContain('subjectIdentity');
  });
});
