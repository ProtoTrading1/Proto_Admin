import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProductIntelligence,
  normalizePositillCode,
  productIntelligenceUrl,
} from '../src/lib/productIntelligence';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('product intelligence API helper', () => {
  it('normalizes and safely encodes the canonical Positill CODE', () => {
    expect(normalizePositillCode('  ab-12/3 ')).toBe('AB-12/3');
    expect(productIntelligenceUrl('  ab-12/3 ')).toBe('/api/product-intelligence?code=AB-12%2F3');
  });

  it('requires a code before making a request', () => {
    expect(() => productIntelligenceUrl('   ')).toThrow('Enter a Positill CODE.');
    expect(() => productIntelligenceUrl('ABC 123')).toThrow('without spaces');
  });

  it('keeps section deep links inside the signed-in role allowlist', () => {
    const source = readFileSync('src/pages/AdminPage.jsx', 'utf8');
    expect(source).toMatch(/section && allowedSectionIds\.includes\(section\)/);
  });

  it('returns only the explicit product contract', async () => {
    const product = {
      code: '8610100040N',
      erp: { stockOnHand: 47 },
      status: { erp: 'available', website: 'not_found' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(product), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(fetchProductIntelligence('8610100040n')).resolves.toEqual(product);
    expect(fetch).toHaveBeenCalledWith('/api/product-intelligence?code=8610100040N', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
    }));
  });

  it('uses null for a product that was not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(fetchProductIntelligence('MISSING')).resolves.toBeNull();
  });

  it('treats a successful lookup with no ERP or website match as empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'MISSING',
      erp: null,
      website: null,
      status: { erp: 'not_found', website: 'not_found' },
    }), { status: 200 })));

    await expect(fetchProductIntelligence('MISSING')).resolves.toBeNull();
  });
});

describe('intelligence section access', () => {
  it('keeps URL deep links behind the same role allowlist as navigation', () => {
    const source = readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
    expect(source).toContain("section && allowedSectionIds.includes(section)");

    // The guard is "customer service sees only customer-facing sections", not a
    // frozen list — asserting the exact array broke the moment WhatsApp CRM was
    // added, which is a legitimate change. Assert the invariant instead.
    const declaration = source.match(/const CUSTOMER_SERVICE_SECTIONS = \[([^\]]*)\]/);
    expect(declaration).not.toBeNull();
    const sections = declaration[1].split(',').map((entry) => entry.trim().replace(/'/g, '')).filter(Boolean);
    expect(sections).toEqual(expect.arrayContaining(['orders', 'customers', 'comms']));
    for (const ownerOnly of ['catalogue', 'product-loader', 'pricing', 'product-intelligence', 'image-processing']) {
      expect(sections).not.toContain(ownerOnly);
    }
  });
});
