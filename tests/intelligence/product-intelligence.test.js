import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildProductIntelligence } from '../../api/_product-intelligence.js';
import { fetchStmastRow } from '../../api/_sql-stmast.js';

function stockClientWith({ sku = null, barcode = null } = {}) {
  return {
    from(table) {
      expect(table).toBe('website_stock');
      return {
        select() {
          return {
            eq(column) {
              return {
                async maybeSingle() {
                  return { data: column === 'sku' ? sku : barcode, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe('product intelligence — read-only combined contract', () => {
  it('combines an exact website product with live ERP data', async () => {
    const result = await buildProductIntelligence({
      code: 'ABC-1',
      stockClient: stockClientWith({
        sku: {
          sku: 'ABC-1', barcode: '6001', title: 'Test product', price: '115',
          stock_qty: 12, available_stock: 10, category: 'Gifts', subcategory_one: 'Novelty',
        },
      }),
      resolveErp: async () => ({
        product: {
          code: 'ABC-1', title: 'TEST PRODUCT', price: 100,
          onhand: 12, booked: 2, available: 10, dept: '09',
        },
        dataSource: 'erp_sql',
        bridgeAttempted: true,
      }),
    });

    expect(result).toMatchObject({
      code: 'ABC-1',
      website: { sku: 'ABC-1', price: 115, availableStock: 10, categoryPath: ['Gifts', 'Novelty'] },
      erp: { code: 'ABC-1', price: 100, stockOnHand: 12, booked: 2, availableStock: 10 },
      sources: { website: 'website_stock', erp: 'erp_sql' },
      status: { website: 'available', erp: 'available', degraded: false },
    });
  });

  it('falls back to an exact barcode match', async () => {
    const result = await buildProductIntelligence({
      code: '6001',
      stockClient: stockClientWith({ barcode: { sku: 'ABC-1', barcode: '6001', title: 'Test product' } }),
      resolveErp: async () => ({ product: null, dataSource: null, bridgeAttempted: false }),
    });

    expect(result.website).toMatchObject({ sku: 'ABC-1', barcode: '6001' });
    expect(result.status.erp).toBe('not_found');
  });

  it('keeps website intelligence available when ERP resolution fails', async () => {
    const result = await buildProductIntelligence({
      code: 'ABC-1',
      stockClient: stockClientWith({ sku: { sku: 'ABC-1', title: 'Test product' } }),
      resolveErp: async () => { throw new Error('bridge offline'); },
    });

    expect(result.website).toMatchObject({ sku: 'ABC-1' });
    expect(result.erp).toBeNull();
    expect(result.sources.erp).toBeNull();
    expect(result.status).toMatchObject({ erp: 'unavailable', degraded: true });
  });

  it('keeps ERP intelligence available when the website catalogue fails', async () => {
    const result = await buildProductIntelligence({
      code: 'ABC-1',
      stockClient: null,
      resolveErp: async () => ({
        product: { code: 'ABC-1', title: 'ERP product', onhand: 8, booked: 1, available: 7 },
        dataSource: 'erp_sql',
        bridgeAttempted: true,
      }),
    });

    expect(result.website).toBeNull();
    expect(result.erp).toMatchObject({ code: 'ABC-1', availableStock: 7 });
    expect(result.status).toMatchObject({ website: 'unavailable', erp: 'available', degraded: true });
    expect(result.capabilities).toEqual({ actionsEnabled: false, positillWritesEnabled: false });
  });

  it('marks the approved cache fallback as degraded', async () => {
    const result = await buildProductIntelligence({
      code: 'ABC-1',
      stockClient: stockClientWith(),
      resolveErp: async () => ({
        product: { code: 'ABC-1', title: 'Cached product', available: 4 },
        dataSource: 'stmast_cache',
        bridgeAttempted: true,
      }),
    });

    expect(result.sources).toEqual({ website: null, erp: 'stmast_cache' });
    expect(result.status).toEqual({ website: 'not_found', erp: 'available', degraded: true });
  });

  it('marks a live-path miss as uncertain when the provider had to absorb a bridge failure', async () => {
    const result = await buildProductIntelligence({
      code: 'UNKNOWN-1',
      stockClient: stockClientWith(),
      resolveErp: async () => ({ product: null, dataSource: null, bridgeAttempted: true }),
    });

    expect(result.status).toEqual({ website: 'not_found', erp: 'not_found', degraded: true });
  });

  it('treats the SQL bridge row-null envelope as an exact CODE miss', async () => {
    const previousUrl = process.env.STOCK_SQL_BRIDGE_URL;
    const previousFetch = globalThis.fetch;
    process.env.STOCK_SQL_BRIDGE_URL = 'https://bridge.example.test';
    globalThis.fetch = async () => new Response(JSON.stringify({ row: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    try {
      await expect(fetchStmastRow('MISSING-TEST-999')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.STOCK_SQL_BRIDGE_URL;
      else process.env.STOCK_SQL_BRIDGE_URL = previousUrl;
    }
  });

  it('keeps the Hermes foundation grid content-sized', () => {
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toMatch(/\.intelligence-panel\s*\{[^}]*align-content:\s*start/);
    expect(css).toMatch(/\.intelligence-callout\s*\{[^}]*justify-content:\s*flex-start/);
  });

  it('keeps the route admin-authenticated and GET-only', () => {
    const source = readFileSync('api/product-intelligence.js', 'utf8');
    expect(source).toMatch(/requireOwner/);
    expect(source).toMatch(/req\.method !== 'GET'/);
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });
});
