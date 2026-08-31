import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');

/**
 * "Orders disappear and only come back after another refresh."
 *
 * loadOrders skips repainting when a response is identical to what is already
 * shown, which is what stopped the Payment/All-orders tabs blinking. That
 * comparison read the `orders` state variable — but loadOrders also runs from
 * a 30s timer and a focus handler, whose closures hold whatever `orders` was
 * when they were created. A stale length that happened to equal the incoming
 * row count marked the response "unchanged" while the list on screen was
 * empty, so the rows never painted and only a manual refresh recovered them.
 */
describe('orders list repaint', () => {
  it('shows the customer business name when the order includes one', () => {
    expect(source).toMatch(/order\.customers\?\.business_name/);
    expect(source).toMatch(/order\.customers\.business_name/);
  });

  it('compares against what is painted, not the captured state variable', () => {
    const block = source.slice(source.indexOf('const loadOrders'), source.indexOf('const loadOrders') + 3000);
    expect(block).toMatch(/const painted = paintedOrdersRef\.current;/);
    expect(block).not.toMatch(/&& orders\.length === data\.rows\.length/);
  });

  it('never skips the paint while nothing is on screen', () => {
    expect(source).toMatch(/\(painted\.length > 0 \|\| data\.rows\.length === 0\)/);
  });

  it('keeps the painted ref in step with every paint', () => {
    const block = source.slice(source.indexOf('const loadOrders'), source.indexOf('const loadOrders') + 3000);
    // Cache paint, blank-on-tab-change, and fresh-data paint all update it.
    const updates = block.match(/paintedOrdersRef\.current = /g) || [];
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('still drops superseded responses', () => {
    expect(source).toMatch(/if \(seq !== ordersReqSeqRef\.current\) return;/);
  });
});
