import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CustomerApplicationDetails, {
  applicationAddress,
  applicationWebsiteHref,
  hasApplicationAnswers,
} from '../src/components/CustomerApplicationDetails.jsx';

describe('customer application details', () => {
  it('shows the structured application answers for pending and approved customers', () => {
    const markup = renderToStaticMarkup(createElement(CustomerApplicationDetails, { customer: {
      is_approved: true,
      created_at: '2026-08-03T08:00:00.000Z',
      sales_channels: ['Physical retail store', 'Market trader'],
      product_categories: ['Gifts & novelty products'],
      business_description: 'We sell gifts to tourists and local walk-in customers.',
      monthly_spend: 'R10,000 – R25,000',
      website: 'cape-gifts.example',
      claimed_customer_code: 'ABC123',
      accept_whatsapp: false,
      vat_number: '4123456789',
      street_name: '12 Long Street',
      suburb: 'City Bowl',
      city: 'Cape Town',
      province: 'Western Cape',
      postal_code: '8001',
      country: 'South Africa',
    } }));

    expect(markup).toContain('Application details');
    expect(markup).toContain('Approved');
    expect(markup).toContain('Physical retail store');
    expect(markup).toContain('Gifts &amp; novelty products');
    expect(markup).toContain('their own words');
    expect(markup).toContain('ABC123');
    expect(markup).toContain('No — opted out');
    expect(markup).toContain('Cape Town');
  });

  it('builds a structured address and safely limits clickable website schemes', () => {
    expect(applicationAddress({ building_type: 'Shop', unit_number: '4', street_name: 'Main Road', city: 'Durban' }))
      .toBe('Shop 4, Main Road, Durban');
    expect(applicationWebsiteHref('example.co.za')).toBe('https://example.co.za/');
    expect(applicationWebsiteHref('TLC Pharmacy Porterville')).toBe('');
    expect(applicationWebsiteHref('javascript:alert(1)')).toBe('');
  });

  it('gives legacy customers a calm empty state', () => {
    expect(hasApplicationAnswers({ created_at: '2024-01-01' })).toBe(false);
    const markup = renderToStaticMarkup(createElement(CustomerApplicationDetails, {
      customer: { created_at: '2024-01-01', is_approved: true },
    }));
    expect(markup).toContain('No structured online-application answers were captured');
  });

  it('shows an on-hold application and its internal reason', () => {
    const markup = renderToStaticMarkup(createElement(CustomerApplicationDetails, {
      customer: {
        is_approved: false,
        application_status: 'on_hold',
        application_hold_reason: 'Waiting for proof of trade.',
      },
    }));
    expect(markup).toContain('On hold');
    expect(markup).toContain('Waiting for proof of trade.');
  });
});
