import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderMatchesTab } from '../src/lib/orderStatus.js';

const source = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');

describe('Payment order tab', () => {
  it('includes sent confirmations awaiting payment and orders with payment received', () => {
    expect(orderMatchesTab({ status: 'order sent', confirmation_sent_at: '2026-09-28T08:00:00Z' }, 'paid')).toBe(true);
    expect(orderMatchesTab({ status: 'payment received' }, 'paid')).toBe(true);
    expect(orderMatchesTab({ status: 'order sent' }, 'paid')).toBe(false);
  });

  it('explains both kinds of orders in the helper text', () => {
    expect(source).toContain('This tab shows confirmations awaiting payment and orders already marked Payment Received.');
  });
});
