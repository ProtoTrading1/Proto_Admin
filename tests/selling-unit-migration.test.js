import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../migrations/057_preserve_website_selling_units.sql', import.meta.url),
  'utf8',
);

describe('selling-unit persistence migration', () => {
  it('keeps price and stock sync while leaving the website selling unit alone', () => {
    expect(sql).toMatch(/set price\s*=\s*NEW\.sell_price/i);
    expect(sql).toMatch(/stock_qty\s*=\s*NEW\.stock_qty/i);
    expect(sql).toMatch(/after insert or update of sell_price, stock_qty, available_stock/i);
    expect(sql).not.toMatch(/units_of_issue\s*=\s*(?:NEW|p)\./i);
  });

  it('keeps the bulk sync server-only', () => {
    expect(sql).toMatch(/revoke execute on function public\.trg_sync_product_to_website_stock\(\) from public/i);
    expect(sql).toMatch(/revoke execute on function public\.sync_website_from_products\(\) from anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.sync_website_from_products\(\) to service_role/i);
  });
});
