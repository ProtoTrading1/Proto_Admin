import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed fulfillment links.
 *
 * The fulfilment team works from a WhatsApp link on a phone. They are not
 * admins and have no Supabase account, so the link itself has to carry the
 * authorization — but a bare `?id=<orderId>` URL would let anyone who can
 * guess or scrape an order UUID open somebody else's order. Instead the link
 * carries an HMAC-signed claim naming exactly one order and an expiry.
 *
 * Token shape: `<base64url(orderId|expiryUnixSeconds)>.<base64url(hmac)>`
 *
 * The claim is self-contained — routes that take no orderId of their own (the
 * team list, for example) still know which order the caller is working on, and
 * routes that do take one compare it against the claim. A token proves "the
 * holder was sent this order's link"; it is never a staff identity, so it can
 * never reach customer-facing or financial actions. See `_fulfillment-auth.js`.
 */

const VERSION = 'v1';
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;

/**
 * Signing key. FULFILLMENT_LINK_SECRET is the intended home; the fallbacks
 * exist so the feature works on an environment that has not set it yet rather
 * than silently shipping unopenable links. Only the HMAC digest ever leaves
 * the server, so a fallback key is not exposed by the token.
 *
 * Rotating whichever value is in use invalidates every outstanding link.
 */
function signingSecret() {
  return String(
    process.env.FULFILLMENT_LINK_SECRET
    || process.env.ADMIN_DASH_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '',
  ).trim();
}

export function isFulfillmentLinkConfigured() {
  return signingSecret().length > 0;
}

export function fulfillmentLinkTtlDays() {
  const raw = Number(process.env.FULFILLMENT_LINK_TTL_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(MAX_TTL_DAYS, Math.floor(raw));
}

function toBase64Url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPayload(payload, secret) {
  return toBase64Url(createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest());
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Compare lengths first: timingSafeEqual throws on a mismatch, and the
  // length of a signature is public information anyway.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Mint a link token for one order. Returns '' when no signing secret is
 * configured — callers fall back to a plain URL rather than sending a link
 * that can never be verified.
 */
export function mintFulfillmentToken(orderId, { ttlDays } = {}) {
  const id = String(orderId || '').trim();
  const secret = signingSecret();
  if (!id || !secret) return '';
  if (id.includes('|')) throw new Error('Order id cannot contain "|"');
  const days = Number.isFinite(ttlDays) && ttlDays > 0
    ? Math.min(MAX_TTL_DAYS, Math.floor(ttlDays))
    : fulfillmentLinkTtlDays();
  const expiry = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const payload = toBase64Url(`${id}|${expiry}`);
  return `${payload}.${signPayload(payload, secret)}`;
}

/**
 * Verify a link token. Returns `{ orderId, expiresAt }` or null — null covers
 * every failure (unsigned, tampered, expired, malformed) so no caller can
 * accidentally treat a rejected token as a partial success.
 */
export function verifyFulfillmentToken(token) {
  const raw = String(token || '').trim();
  const secret = signingSecret();
  if (!raw || !secret) return null;

  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  if (!constantTimeEqual(signature, signPayload(payload, secret))) return null;

  let decoded;
  try {
    decoded = fromBase64Url(payload);
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) return null;
  const orderId = decoded.slice(0, separator);
  const expiry = Number(decoded.slice(separator + 1));
  if (!orderId || !Number.isFinite(expiry)) return null;
  if (expiry * 1000 <= Date.now()) return null;

  return { orderId, expiresAt: new Date(expiry * 1000).toISOString() };
}

/**
 * The URL the team receives. The order id stays visible in the path so anyone
 * reading a WhatsApp log can tell which order a link is for without decoding
 * the token.
 */
export function buildSignedFulfillmentUrl(origin, orderId, options) {
  const base = String(origin || '').replace(/\/$/, '');
  const id = String(orderId || '').trim();
  if (!id) return '';
  const token = mintFulfillmentToken(id, options);
  if (!token) return `${base}/fulfillment?id=${encodeURIComponent(id)}`;
  return `${base}/f/${encodeURIComponent(id)}/${token}`;
}
