import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifiedLiveInstoreStock } from '../lib/instore-live-stock.mjs';

const upload = readFileSync(new URL('../src/components/productLoader/ProductLoaderUpload.jsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/lib/productLoaderApi.js', import.meta.url), 'utf8');
const route = readFileSync(new URL('../api/nutstore-process.js', import.meta.url), 'utf8');

describe('already-GRV’d Instore import', () => {
  it('accepts the exact rhinestone sticker Positill row as CARD, without a receipt line', () => {
    expect(verifiedLiveInstoreStock({ CODE: '8620200200', UNITS: 'CARD', ONHAND: 49, BOOKED: 0 }, '8620200200'))
      .toMatchObject({ blocker: '', unitsOfIssue: 'CARD', sellableQty: 49 });
  });

  it('fails closed on an inexact SKU, missing unit, missing fields, unsafe stock, or less than 10 available', () => {
    const valid = { CODE: '8620200200', UNITS: 'CARD', ONHAND: 49, BOOKED: 0 };
    for (const row of [
      { ...valid, CODE: '8620200201' },
      { ...valid, UNITS: '' },
      { ...valid, BOOKED: undefined },
      { ...valid, stock_fields_verified: false },
      { ...valid, ONHAND: 5 },
      { ...valid, ONHAND: 10, BOOKED: 1 },
      { ...valid, ONHAND: -1 },
      { ...valid, ONHAND: 12.5 },
    ]) expect(verifiedLiveInstoreStock(row, '8620200200').blocker).toBeTruthy();
  });

  it('keeps the received-Excel path separate and revalidates live stock on the server', () => {
    expect(upload).toContain('Already GRV’d — live Positill stock');
    expect(upload).toContain('New receipt — Stock Received Excel');
    expect(upload).toContain('verifiedLiveInstoreStock(row.sqlRow, row.code)');
    expect(api).toContain("action: stockMode === 'positill_live' ? 'instore_live' : 'instore'");
    expect(route).toContain("stockMode === 'positill_live' ? verifiedLiveInstoreStock(raw, sku) : null");
    expect(route).toContain("if (action === 'instore_live' && items.some((item) => item?.receiptLines?.length))");
    expect(route).toContain("available_stock: sellableQty");
    expect(route).toContain("'local_folder_instore_live_import'");
  });

  it('shows the stock-source choice before a folder is uploaded', () => {
    expect(upload.indexOf('Stock source for this import')).toBeLessThan(upload.indexOf('{items.length > 0 && ('));
    expect(upload).toContain("instoreStockMode === 'received' && <button");
  });
});
