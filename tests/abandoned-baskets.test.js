import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  basketActivityMs,
  basketExportRows,
  buildAbandonedBaskets,
  filterBaskets,
  normaliseLine,
  sortBaskets,
  stalenessBucket,
  summariseBasket,
  summariseBaskets,
} from '../lib/abandoned-baskets.mjs';

const apiSource = fs.readFileSync(new URL('../api/abandoned-baskets.js', import.meta.url), 'utf8');
const panelSource = fs.readFileSync(new URL('../src/components/AbandonedBasketsPanel.jsx', import.meta.url), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

const line = (over = {}) => ({
  product: { id: 'SKU1', sku: 'SKU1', code: 'BAR1', name: 'Glue Stick', price: 25, ...over.product },
  qty: 2,
  ...over,
});

const cart = (over = {}) => ({
  customer_id: 'cust-1',
  items: [line()],
  activity_at: NOW - DAY,
  updated_at: new Date(NOW - DAY).toISOString(),
  ...over,
});

const customer = (over = {}) => ({
  id: 'cust-1',
  name: 'Thabo Nkosi',
  business_name: 'Nkosi Stationers',
  email: 'thabo@example.com',
  phone: '0821234567',
  customer_code: 'ABC123',
  is_approved: true,
  tags: ['10000 club'],
  ...over,
});

describe('normaliseLine', () => {
  it('keeps a whole line and computes its total', () => {
    expect(normaliseLine(line())).toMatchObject({ sku: 'SKU1', qty: 2, price: 25, lineTotal: 50 });
  });

  it('drops lines with no product, no identifier or a non-positive qty', () => {
    expect(normaliseLine({ qty: 2 })).toBeNull();
    expect(normaliseLine({ product: { name: 'No id' }, qty: 1 })).toBeNull();
    expect(normaliseLine(line({ qty: 0 }))).toBeNull();
    expect(normaliseLine(line({ qty: 1.5 }))).toBeNull();
  });

  it('falls back through id/sku/code for the identifier', () => {
    expect(normaliseLine({ product: { id: 'FROM-ID' }, qty: 1 }).sku).toBe('FROM-ID');
    expect(normaliseLine({ product: { code: 'FROM-CODE' }, qty: 1 }).sku).toBe('FROM-CODE');
  });

  it('treats a missing or negative price as zero rather than NaN', () => {
    expect(normaliseLine(line({ product: { sku: 'S', price: undefined } })).lineTotal).toBe(0);
    expect(normaliseLine(line({ product: { sku: 'S', price: -10 } })).price).toBe(0);
  });
});

describe('summariseBasket', () => {
  it('totals value, lines and units', () => {
    const totals = summariseBasket({
      items: [line(), line({ product: { sku: 'SKU2', price: 100 }, qty: 3 })],
    });
    expect(totals).toMatchObject({ lineCount: 2, totalQty: 5, value: 350 });
  });

  it('returns null for an emptied basket — that customer did check out', () => {
    expect(summariseBasket({ items: [] })).toBeNull();
    expect(summariseBasket({ items: null })).toBeNull();
    expect(summariseBasket({})).toBeNull();
  });

  it('returns null when every line is malformed', () => {
    expect(summariseBasket({ items: [{ qty: 1 }, { product: {}, qty: 1 }] })).toBeNull();
  });

  it('counts out-of-stock lines', () => {
    const totals = summariseBasket({
      items: [line(), line({ product: { sku: 'SKU2', inStock: false } })],
    });
    expect(totals.outOfStockLines).toBe(1);
  });
});

describe('basketActivityMs', () => {
  it('prefers activity_at', () => {
    expect(basketActivityMs({ activity_at: 1000, updated_at: '2026-01-01T00:00:00Z' })).toBe(1000);
  });

  it('falls back to updated_at when activity_at is absent or invalid', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(basketActivityMs({ updated_at: iso })).toBe(Date.parse(iso));
    expect(basketActivityMs({ activity_at: 0, updated_at: iso })).toBe(Date.parse(iso));
  });

  it('returns null when neither is usable', () => {
    expect(basketActivityMs({})).toBeNull();
    expect(basketActivityMs({ updated_at: 'not a date' })).toBeNull();
  });
});

describe('stalenessBucket', () => {
  it('splits on the action thresholds', () => {
    expect(stalenessBucket(0)).toBe('active');
    expect(stalenessBucket(2)).toBe('active');
    expect(stalenessBucket(3)).toBe('cooling');
    expect(stalenessBucket(7)).toBe('cooling');
    expect(stalenessBucket(31)).toBe('stale');
    expect(stalenessBucket(null)).toBe('unknown');
  });
});

describe('buildAbandonedBaskets', () => {
  it('joins customer detail onto the basket', () => {
    const [row] = buildAbandonedBaskets({ carts: [cart()], customers: [customer()], now: NOW });
    expect(row).toMatchObject({
      customerId: 'cust-1',
      name: 'Thabo Nkosi',
      businessName: 'Nkosi Stationers',
      email: 'thabo@example.com',
      customerCode: 'ABC123',
      value: 50,
      lineCount: 1,
      staleness: 'active',
      ageDays: 1,
    });
  });

  it('excludes emptied baskets — the checked-out customers', () => {
    const rows = buildAbandonedBaskets({
      carts: [cart(), cart({ customer_id: 'cust-2', items: [] })],
      customers: [customer(), customer({ id: 'cust-2' })],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe('cust-1');
  });

  it('keeps an orphaned basket visible and flags it', () => {
    const [row] = buildAbandonedBaskets({ carts: [cart()], customers: [], now: NOW });
    expect(row.missing).toBe(true);
    expect(row.name).toBe('Unknown customer');
    expect(row.value).toBe(50);
  });

  it('names a customer from a fallback field when name is blank', () => {
    const [row] = buildAbandonedBaskets({
      carts: [cart()],
      customers: [customer({ name: '', contact_name: 'Contact Person' })],
      now: NOW,
    });
    expect(row.name).toBe('Contact Person');
  });

  it('buckets by how long the basket has sat', () => {
    const rows = buildAbandonedBaskets({
      carts: [
        cart({ customer_id: 'a', activity_at: NOW - DAY }),
        cart({ customer_id: 'b', activity_at: NOW - 5 * DAY }),
        cart({ customer_id: 'c', activity_at: NOW - 31 * DAY }),
      ],
      customers: [],
      now: NOW,
    });
    expect(rows.map((r) => r.staleness)).toEqual(['active', 'cooling', 'stale']);
  });

  it('keeps a basket cooling through day thirty', () => {
    expect(stalenessBucket(30)).toBe('cooling');
    expect(stalenessBucket(30.01)).toBe('stale');
  });
});

describe('summariseBaskets', () => {
  const rows = buildAbandonedBaskets({
    carts: [
      cart({ customer_id: 'a', activity_at: NOW - DAY }),
      cart({ customer_id: 'b', items: [line({ qty: 10 })], activity_at: NOW - 31 * DAY }),
    ],
    customers: [customer({ id: 'a' }), customer({ id: 'b', email: '' })],
    now: NOW,
  });

  it('totals value and units across baskets', () => {
    const summary = summariseBaskets(rows);
    expect(summary.basketCount).toBe(2);
    expect(summary.totalValue).toBe(300);
    expect(summary.avgValue).toBe(150);
    expect(summary.biggestValue).toBe(250);
    expect(summary.totalUnits).toBe(12);
  });

  it('reports the VAT already inside the total rather than adding any', () => {
    const summary = summariseBaskets(rows);
    expect(summary.vatIncluded).toBeCloseTo(300 * (15 / 115), 6);
    expect(summary.vatIncluded).toBeLessThan(summary.totalValue);
  });

  it('counts staleness buckets and who is contactable', () => {
    const summary = summariseBaskets(rows);
    expect(summary.activeCount).toBe(1);
    expect(summary.staleCount).toBe(1);
    expect(summary.contactableCount).toBe(1);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(summariseBaskets([])).toMatchObject({ basketCount: 0, totalValue: 0, avgValue: 0, biggestValue: 0 });
  });
});

describe('sortBaskets and filterBaskets', () => {
  const rows = buildAbandonedBaskets({
    carts: [
      cart({ customer_id: 'a', items: [line({ qty: 1 })], activity_at: NOW - 31 * DAY }),
      cart({ customer_id: 'b', items: [line({ qty: 10 })], activity_at: NOW - DAY }),
    ],
    customers: [customer({ id: 'a', name: 'Zara' }), customer({ id: 'b', name: 'Andile' })],
    now: NOW,
  });

  it('sorts by value, recency and name', () => {
    expect(sortBaskets(rows, 'value').map((r) => r.customerId)).toEqual(['b', 'a']);
    expect(sortBaskets(rows, 'recent').map((r) => r.customerId)).toEqual(['b', 'a']);
    expect(sortBaskets(rows, 'oldest').map((r) => r.customerId)).toEqual(['a', 'b']);
    expect(sortBaskets(rows, 'name').map((r) => r.customerId)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const order = rows.map((r) => r.customerId);
    sortBaskets(rows, 'oldest');
    expect(rows.map((r) => r.customerId)).toEqual(order);
  });

  it('filters by staleness', () => {
    expect(filterBaskets(rows, { staleness: 'stale' }).map((r) => r.customerId)).toEqual(['a']);
    expect(filterBaskets(rows, { staleness: 'all' })).toHaveLength(2);
  });

  it('searches customer detail and basket contents', () => {
    expect(filterBaskets(rows, { search: 'zara' }).map((r) => r.customerId)).toEqual(['a']);
    expect(filterBaskets(rows, { search: 'glue' })).toHaveLength(2);
    expect(filterBaskets(rows, { search: 'SKU1' })).toHaveLength(2);
    expect(filterBaskets(rows, { search: 'nothing here' })).toHaveLength(0);
  });
});

describe('basketExportRows', () => {
  it('emits one row per basket line carrying the customer across', () => {
    const rows = buildAbandonedBaskets({
      carts: [cart({ items: [line(), line({ product: { sku: 'SKU2', name: 'Tape' } })] })],
      customers: [customer()],
      now: NOW,
    });
    const exported = basketExportRows(rows);
    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({ Customer: 'Thabo Nkosi', SKU: 'SKU1', Qty: 2 });
    expect(exported[1].SKU).toBe('SKU2');
    expect(exported.every((row) => row.Email === 'thabo@example.com')).toBe(true);
  });
});

describe('basket retention controls', () => {
  it('lets an admin mark an idle saved basket active without changing its contents', () => {
    expect(apiSource).toContain("action !== 'mark-active'");
    expect(apiSource).toContain("update({ activity_at: now, updated_at: new Date(now).toISOString() })");
    expect(apiSource).not.toMatch(/update\(\{[^}]*items/s);
    expect(panelSource).toContain('Mark active now');
  });

  it('makes the unlimited retention policy explicit', () => {
    expect(panelSource).toContain('All signed-in customer baskets are saved indefinitely');
    expect(panelSource).toContain('Gone Cold (30+ Days)');
    expect(panelSource).toContain('Saved indefinitely until the customer clears or submits it');
  });
});
