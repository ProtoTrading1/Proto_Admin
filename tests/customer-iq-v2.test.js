import { describe, expect, it } from 'vitest';
import { buildCustomerIq, daysBetween, median } from '../src/lib/customerIq';

const order = (date, items, total = 0) => ({ created_at: date, original_items: items, total_ex_vat: total });

describe('Customer IQ v2', () => {
  it('uses a median recent ordering rhythm so one long gap does not distort the signal', () => {
    expect(median([20, 30, 400])).toBe(30);
    expect(daysBetween('2026-07-01', '2026-08-01')).toBe(31);
  });

  it('marks an approved customer without orders as a first-order opportunity', () => {
    const iq = buildCustomerIq({
      customer: { is_approved: true, business_name: 'New Gift Shop', product_categories: ['Gift shop'] },
      now: '2026-08-03T00:00:00.000Z',
    });
    expect(iq.contractVersion).toBe('customer-iq.v2');
    expect(iq.status.key).toBe('first_order');
    expect(iq.metrics.lastOrder).toBeNull();
    expect(iq.metrics.daysSinceOrder).toBeNull();
    expect(iq.signals.some((signal) => signal.key === 'next_step')).toBe(true);
  });

  it('keeps the customer supplied business description as attributed AI-ready context', () => {
    const iq = buildCustomerIq({
      customer: { business_description: 'We supply art classes and holiday workshops.' },
      now: '2026-08-03T00:00:00.000Z',
    });
    expect(iq.signals.find((signal) => signal.key === 'customer_words')).toMatchObject({
      detail: 'We supply art classes and holiday workshops.',
      source: 'Online application · Customer supplied',
    });
  });

  it('finds repeat products and calculates their typical quantity', () => {
    const iq = buildCustomerIq({
      customer: { is_approved: true },
      orders: [
        order('2026-07-20', [{ code: 'BEAD1', name: 'Glass bead', qty: 3 }], 100),
        order('2026-06-20', [{ code: 'BEAD1', name: 'Glass bead', qty: 5 }], 150),
        order('2026-05-20', [{ code: 'BEAD1', name: 'Glass bead', qty: 4 }], 120),
      ],
      totalOrders: 3,
      now: '2026-08-03T00:00:00.000Z',
    });
    expect(iq.metrics.rhythmDays).toBe(30.5);
    expect(iq.metrics.spend).toBe(370);
    expect(iq.reorderProducts[0]).toMatchObject({ sku: 'BEAD1', orderCount: 3, typicalQuantity: 4 });
  });

  it('treats a claimed old code as unverified evidence, never the assigned code', () => {
    const iq = buildCustomerIq({
      customer: { is_approved: true, customer_code: 'NEW123', claimed_customer_code: 'OLD999' },
      now: '2026-08-03T00:00:00.000Z',
    });
    expect(iq.customer.assignedCode).toBe('NEW123');
    expect(iq.signals.find((signal) => signal.key === 'claimed_code')?.detail).toContain('Do not use it as an account match');
  });

  it('labels a limited portal-order window as partial evidence', () => {
    const iq = buildCustomerIq({
      customer: { is_approved: true },
      orders: [order('2026-07-20', [], 10)],
      totalOrders: 25,
      now: '2026-08-03T00:00:00.000Z',
    });
    expect(iq.evidence.partial).toBe(true);
    expect(iq.metrics.spendLabel).toContain('partial');
  });
});
