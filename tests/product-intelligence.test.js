import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProductIntelligence,
  normalizePositillCode,
  productIntelligenceUrl,
} from '../src/lib/productIntelligence';
import {
  buildProductAnswer,
  extractProductCode,
  formatApolloMoney,
} from '../src/lib/apolloConversation';
import { askApolloOperations, classifyApolloQuestion } from '../src/lib/apolloOperations';

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
    expect(source).toContain("const CUSTOMER_SERVICE_SECTIONS = ['orders', 'customers', 'comms']");
  });
});

describe('Apollo conversation model', () => {
  it('does not nest a second main landmark inside the admin page', () => {
    const source = readFileSync(new URL('../src/components/HermesPanel.jsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/<main\b/);
  });

  it('extracts an exact product code from a natural-language question', () => {
    expect(extractProductCode('Tell me everything about code 8610100040n.')).toBe('8610100040N');
    expect(extractProductCode('How are sales today?')).toBe('');
  });

  it('routes operational questions to the correct read-only source family', () => {
    expect(classifyApolloQuestion('What needs my attention across Proto?')).toMatchObject({ kind: 'analytics', focus: 'overview' });
    expect(classifyApolloQuestion('What products and categories are customers viewing?')).toMatchObject({ kind: 'analytics', focus: 'customer_attention' });
    expect(classifyApolloQuestion('What are customers searching for but not finding?')).toMatchObject({ kind: 'analytics', focus: 'search' });
    expect(classifyApolloQuestion('Are the bridge and backend healthy?')).toMatchObject({ kind: 'health' });
    expect(classifyApolloQuestion('Are any images waiting in review?')).toMatchObject({ kind: 'images' });
    expect(classifyApolloQuestion('How are orders this week?')).toMatchObject({ kind: 'analytics', focus: 'orders', periodDays: 7 });
    expect(classifyApolloQuestion('What are customers viewing today?')).toMatchObject({ kind: 'analytics', focus: 'customer_attention', periodDays: 1, periodKey: 'today' });
    expect(classifyApolloQuestion('What happened in the last 24 hours?')).toMatchObject({ periodDays: 1, periodKey: 'rolling' });
  });

  it('keeps keyboard submission and broad evidence guidance in Apollo', () => {
    const source = readFileSync(new URL('../src/components/HermesPanel.jsx', import.meta.url), 'utf8');
    expect(source).toContain('onKeyDown={handleQuestionKeyDown}');
    expect(source).toContain('Ask Apollo a question to load the approved operational evidence.');
    expect(source).not.toContain('Ask about an exact product code to compare the sources.');
  });

  it('does not send the free-text question or customer details to Codex', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { summary: 'Safe aggregate answer', findings: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await askApolloOperations('Tell me about customer Jane Doe and jane@example.com');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({ periodDays: 30, focus: 'overview' });
    expect(JSON.stringify(body)).not.toContain('Jane');
    expect(JSON.stringify(body)).not.toContain('example.com');
  });

  it('requests an exact today window without sending the free-text question', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { summary: 'Today only', findings: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await askApolloOperations('What products are customers viewing today?');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ periodDays: 1, focus: 'customer_attention', periodKey: 'today' });
  });

  it('builds a read-only answer from the existing product contract', () => {
    const answer = buildProductAnswer({
      code: '8610100040N',
      generatedAt: '2026-08-29T08:42:00.000Z',
      erp: { code: '8610100040N', title: 'ALMOND MILK 1L', price: 68.7, stockOnHand: 38, booked: 4, availableStock: 34, department: '35' },
      website: { sku: '8610100040N', title: 'Almond Milk 1L', price: 79, stockOnHand: 45, availableStock: 42, categoryPath: ['Food', 'Drinks'] },
      sources: { erp: 'erp_sql', website: 'website_stock' },
      status: { erp: 'available', website: 'available', degraded: false },
    }, '8610100040N');

    expect(answer).toMatchObject({
      code: '8610100040N',
      title: 'ALMOND MILK 1L',
      stockDifference: 8,
      confidence: 'High',
      positill: { source: 'Live Positill', availableStock: '34 units' },
      website: { source: 'Website catalogue', availableStock: '42 units' },
    });
    expect(answer.summary).toContain('8 units higher than Positill');
    expect(formatApolloMoney(79).replace(/\s/g, ' ')).toBe('R 79,00');
  });
});
