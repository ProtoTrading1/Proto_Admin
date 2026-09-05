import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const adminPage = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');

describe('trade request approval flow', () => {
  it('keeps the admin on Trade Requests after approval and refreshes that list', () => {
    const handler = adminPage.slice(
      adminPage.indexOf('const approveRequest = async'),
      adminPage.indexOf('const removeCustomer = async'),
    );

    expect(handler).toContain('await loadCustomers();');
    expect(handler).not.toContain("setCustomerTab('regular')");
  });
});
