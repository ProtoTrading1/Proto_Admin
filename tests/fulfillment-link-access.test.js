import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Signed fulfilment links let the packing team open ONE order from WhatsApp
 * without an admin account. Two things must hold for that to be safe:
 *
 *  1. the token can only be produced by someone holding the signing secret,
 *     names exactly one order, and stops working when it expires; and
 *  2. a link can never reach a customer-facing or financial action.
 */

const ORDER_ID = '11111111-2222-3333-4444-555555555555';

async function loadTokenModule() {
  vi.resetModules();
  return import('../api/_fulfillment-token.js');
}

describe('fulfillment link tokens', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FULFILLMENT_LINK_SECRET = 'test-signing-secret';
    delete process.env.FULFILLMENT_LINK_TTL_DAYS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
  });

  it('round-trips the order id it was minted for', async () => {
    const { mintFulfillmentToken, verifyFulfillmentToken } = await loadTokenModule();
    const token = mintFulfillmentToken(ORDER_ID);
    expect(token).toBeTruthy();
    expect(verifyFulfillmentToken(token)?.orderId).toBe(ORDER_ID);
  });

  it('rejects a tampered payload', async () => {
    const { mintFulfillmentToken, verifyFulfillmentToken } = await loadTokenModule();
    const token = mintFulfillmentToken(ORDER_ID);
    const [, signature] = token.split('.');
    // Same signature, different order — the swap a scraped link would attempt.
    const forgedPayload = Buffer.from(`99999999-0000-0000-0000-000000000000|${Math.floor(Date.now() / 1000) + 600}`)
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyFulfillmentToken(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const { mintFulfillmentToken } = await loadTokenModule();
    const token = mintFulfillmentToken(ORDER_ID);
    process.env.FULFILLMENT_LINK_SECRET = 'a-different-secret';
    const { verifyFulfillmentToken } = await loadTokenModule();
    expect(verifyFulfillmentToken(token)).toBeNull();
  });

  it('rejects malformed input rather than throwing', async () => {
    const { verifyFulfillmentToken } = await loadTokenModule();
    for (const bad of ['', 'nonsense', 'a.b.c', '.', 'YWJj', null, undefined]) {
      expect(verifyFulfillmentToken(bad)).toBeNull();
    }
  });

  it('expires', async () => {
    process.env.FULFILLMENT_LINK_TTL_DAYS = '1';
    const { mintFulfillmentToken, verifyFulfillmentToken } = await loadTokenModule();
    const token = mintFulfillmentToken(ORDER_ID);
    expect(verifyFulfillmentToken(token)).not.toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
    expect(verifyFulfillmentToken(token)).toBeNull();
  });

  it('mints nothing when no signing secret is configured', async () => {
    delete process.env.FULFILLMENT_LINK_SECRET;
    delete process.env.ADMIN_DASH_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { mintFulfillmentToken, isFulfillmentLinkConfigured, buildSignedFulfillmentUrl } = await loadTokenModule();
    expect(isFulfillmentLinkConfigured()).toBe(false);
    expect(mintFulfillmentToken(ORDER_ID)).toBe('');
    // Falls back to the sign-in URL rather than a link that cannot verify.
    expect(buildSignedFulfillmentUrl('https://admin.proto.co.za', ORDER_ID))
      .toBe(`https://admin.proto.co.za/fulfillment?id=${ORDER_ID}`);
  });

  it('builds a link carrying the order id and its token', async () => {
    const { buildSignedFulfillmentUrl, verifyFulfillmentToken } = await loadTokenModule();
    const url = buildSignedFulfillmentUrl('https://admin.proto.co.za/', ORDER_ID);
    const match = url.match(/^https:\/\/admin\.proto\.co\.za\/f\/([^/]+)\/(.+)$/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(ORDER_ID);
    expect(verifyFulfillmentToken(match[2])?.orderId).toBe(ORDER_ID);
  });
});

describe('what a fulfilment link may reach', () => {
  const read = (file) => readFileSync(new URL(`../api/${file}`, import.meta.url), 'utf8');

  it.each([
    ['send-order-email.js', 'emails the customer'],
    ['order-notification.js', 'emails the order team for any order id'],
    ['order-notify-log.js', 'reads any order id\'s notify log'],
  ])('%s refuses order-link auth (%s)', (file) => {
    const source = read(file);
    expect(source).toContain('requireAdminAuthType');
  });

  it('the WhatsApp broadcast sends a signed link', () => {
    const source = read('order-team-whatsapp.js');
    expect(source).toContain('buildSignedFulfillmentUrl');
    // The old unsigned URL let anyone with an order UUID open the packing page.
    expect(source).not.toContain('/fulfillment?id=${encodeURIComponent(order.id)}');
  });

  it('order-scoped routes still compare the caller\'s order against their own', () => {
    expect(read('admin-orders.js')).toContain('assertOrderScope');
    expect(read('fulfillment-progress.js')).toContain("auth.type === 'order'");
  });

  it('keeps customer sends and payment records off links', () => {
    const source = read('_fulfillment-auth.js');
    expect(source).toContain('order sent');
    expect(source).toContain('payment received');
  });
});
