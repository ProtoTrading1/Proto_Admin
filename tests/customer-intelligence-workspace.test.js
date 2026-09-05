import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CustomerIntelligenceWorkspace from '../src/components/CustomerIntelligenceWorkspace';

const source = readFileSync(new URL('../src/components/CustomerIntelligenceWorkspace.jsx', import.meta.url), 'utf8');

describe('Customer Intelligence Workspace', () => {
  it('renders the staff action, evidence bands and explicit decision safeguard', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIntelligenceWorkspace, {
        customer: {
          id: 'customer-1',
          is_approved: true,
          business_name: 'Creative Corner',
          name: 'Kira Buyer',
          customer_code: 'CREATE',
          email: 'buyer@example.test',
          phone: '0210000000',
          monthly_spend: 'R10,000 – R25,000',
          sales_channels: ['Physical retail store'],
          product_categories: ['Art, craft & beads'],
          business_description: 'We run workshops and sell craft kits.',
        },
        orders: [],
        totalOrders: 0,
        source: 'portal',
      }),
    );

    expect(html).toContain('Customer intelligence workspace');
    expect(html).toContain('Recommended next staff action');
    expect(html).toContain('Help with a first order');
    expect(html).toContain('Trader confidence');
    expect(html).toContain('Customer potential');
    expect(html).toContain('Engagement health');
    expect(html).toContain('Not enough data');
    expect(html).toContain('Data confidence');
    expect(html).toContain('never approves, declines, contacts or changes a customer');
    expect(html).not.toContain('100%');
  });

  it('labels a partial portal-order window honestly', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIntelligenceWorkspace, {
        customer: { id: 'customer-2', is_approved: true, business_name: 'Busy Store' },
        orders: [{ id: 'order-1', created_at: '2026-08-01', total_ex_vat: 500 }],
        totalOrders: 12,
        source: 'portal',
      }),
    );

    expect(html).toContain('Showing the latest 1 of 12 portal orders');
    expect(html).toContain('partial');
  });

  it('labels imported Positill figures as the 2025/26 VAT-inclusive financial year', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIntelligenceWorkspace, {
        customer: {
          id: 'sm-watch',
          is_approved: true,
          name: 'S.M. Watch Wholesalers',
          account_code: 'SMWATC',
          sales_last_12_months: 184880,
          invoice_count: 9,
          last_purchase_date: '2026-04-21',
        },
        source: 'proto-active',
      }),
    );

    expect(html).toContain('2025/26 FY sales (incl. VAT)');
    expect(html).toContain('2025/26 FY invoices');
    expect(html).toContain('1 Jul 2025–30 Jun 2026, incl. VAT');
    expect(html).toContain('Later transactions may not yet be included');
    expect(html).not.toContain('12mo');
  });

  it('keeps the imported-snapshot warning after a historical customer registers online', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomerIntelligenceWorkspace, {
        customer: {
          id: 'approved-sm-watch',
          is_approved: true,
          business_name: 'S.M. Watch Wholesalers',
          sales_last_12_months: 73580,
          invoice_count: 0,
        },
        source: 'portal',
      }),
    );

    expect(html).toContain('2025/26 financial year sales');
    expect(html).toContain('Imported Positill snapshot');
    expect(html).toContain('Later transactions may not yet be included');
  });

  it('defines accessible tabs and keeps staff approval outside the workspace', () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(source).toContain('Staff notes and follow-ups are not connected yet');
    expect(source).not.toContain('approveCustomer');
    expect(source).not.toContain('sendCustomerEmailBroadcast');
  });
});
