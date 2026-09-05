import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolveProductAvailability } from '../lib/product-availability.mjs';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

describe('product availability contract', () => {
  it('keeps stock, made-to-order and incoming shipment states distinct', () => {
    expect(resolveProductAvailability({ stockQty: 10, toOrder: true }).state).toBe('in_stock');
    expect(resolveProductAvailability({ stockQty: 1 }).state).toBe('low_stock');
    expect(resolveProductAvailability({ stockQty: -1 }).canOrder).toBe(false);
    expect(resolveProductAvailability({ stockQty: 0, toOrder: true }).state).toBe('to_order');
    expect(resolveProductAvailability({
      stockQty: 0,
      incoming: { incomingStatus: 'landed_awaiting_grv', incomingQty: 40 },
    })).toMatchObject({ state: 'landed', canOrder: true });
    expect(resolveProductAvailability({
      stockQty: 0,
      incoming: { incomingStatus: 'on_the_way', incomingQty: 40 },
    })).toMatchObject({ state: 'incoming', canOrder: false });
  });

  it('keeps the availability table private to server-side code', async () => {
    const migration = await readSource('migrations/059_product_availability_sync.sql');
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/revoke all[\s\S]*public, anon, authenticated/i);
    expect(migration).toMatch(/grant select, insert, update, delete[\s\S]*service_role/i);
    expect(migration).toMatch(/get_website_product_availability\(p_skus text\[\]/);
    expect(migration).toMatch(/Deliberately excludes internal shipment reference/i);
    expect(migration).toMatch(/reconcile_website_product_availability_after_grv/);
    expect(migration).toMatch(/incoming_qty = outstanding_qty - received_qty/);
    expect(migration).toMatch(/landed_awaiting_grv/);
  });

  it('exposes separate made-to-order and incoming-container controls', async () => {
    const [page, actions] = await Promise.all([
      readSource('src/pages/AdminPage.jsx'),
      readSource('api/stock-actions.js'),
    ]);
    expect(page).toMatch(/Made \/ sourced to order/);
    expect(page).toMatch(/Incoming container stock/);
    expect(page).toMatch(/Landed — awaiting GRV/);
    expect(actions).toMatch(/action === 'setToOrder'/);
    expect(actions).toMatch(/action === 'setProductAvailability'/);
  });

  it('exposes Stock available as a quantity-free Product Manager toggle', async () => {
    const [manager, mutations, catalog, adapt] = await Promise.all([
      readSource('src/components/ProductManagerEngine.jsx'),
      readSource('src/hooks/useCatalogMutations.js'),
      readSource('api/catalog.js'),
      readSource('api/_catalog-adapt.js'),
    ]);
    expect(manager).toMatch(/Stock available/);
    expect(manager).toMatch(/const stockAvailable = !item\.stockAvailable/);
    expect(manager).not.toMatch(/window\.prompt|How many units/);
    expect(mutations).toMatch(/incomingQty: stockAvailable \? 0\.001 : 0/);
    expect(catalog).toMatch(/enrichRowsWithIncomingAvailability/);
    expect(adapt).toMatch(/stockAvailable:/);
  });
});
