import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CustomerIqPanel from '../src/components/CustomerIqPanel';

describe('Customer IQ panel', () => {
  it('renders attributed application context, metrics, and repeat-product evidence', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIqPanel, {
        customer: {
          is_approved: true,
          business_name: 'Creative Corner',
          sales_channels: ['Retail store'],
          product_categories: ['Craft & bead shop'],
          business_description: 'We run workshops and sell craft kits.',
        },
        orders: [
          { created_at: '2026-07-20', total_ex_vat: 200, original_items: [{ code: 'KIT1', name: 'Starter craft kit', qty: 3 }] },
          { created_at: '2026-06-20', total_ex_vat: 150, original_items: [{ code: 'KIT1', name: 'Starter craft kit', qty: 2 }] },
        ],
        totalOrders: 2,
        source: 'portal',
      }),
    );

    expect(html).toContain('Customer IQ');
    expect(html).toContain('Creative Corner');
    expect(html).toContain('We run workshops and sell craft kits.');
    expect(html).toContain('Online application · Customer supplied');
    expect(html).toContain('Starter craft kit');
    expect(html).toContain('Seen in 2 loaded orders');
    expect(html).toContain('no action is automated');
  });

  it('shows an honest loading state without presenting unfinished metrics', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIqPanel, {
        customer: { business_name: 'Loading Customer' },
        orders: [],
        source: 'portal',
        loading: true,
      }),
    );
    expect(html).toContain('Analysing recorded orders');
    expect(html).not.toContain('Repeat-product shortlist');
  });
});
