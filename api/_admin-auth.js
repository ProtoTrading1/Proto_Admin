import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyFulfillmentToken } from './_fulfillment-token.js';

/**
 * Admin API auth — Supabase JWT + email allowlist.
 *
 * Fulfillment routes additionally accept a signed per-order link token
 * (`_fulfillment-token.js`), which the packing team opens from WhatsApp
 * without an account. That token authorizes ONE order and only the packing
 * workflow — never a customer-facing send or a financial record.
 */

export const ADMIN_ROLES = Object.freeze({
  OWNER: 'owner',
  CUSTOMER_SERVICE: 'customer_service',
});

// Server-side source of truth for the current small admin team. Authorization
// is based on the verified Supabase user's email, never a browser-supplied role.
export const ADMIN_USERS = new Map([
  ['danieljoffeinfo@gmail.com', ADMIN_ROLES.OWNER],
  ['george@proto.co.za', ADMIN_ROLES.OWNER],
  ['online@proto.co.za', ADMIN_ROLES.OWNER],
]);

export const ADMIN_EMAILS = new Set(ADMIN_USERS.keys());

export function getAdminRole(email) {
  return ADMIN_USERS.get(String(email || '').trim().toLowerCase()) || null;
}

export function isOwnerEmail(email) {
  return getAdminRole(email) === ADMIN_ROLES.OWNER;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function getSupabaseAuthClient() {
  const url = process.env.ADMIN_AUTH_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.ADMIN_AUTH_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing admin authentication Supabase configuration');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

export async function verifyAdminUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const supabase = getSupabaseAuthClient();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email || !isAdminEmail(user.email)) return null;
    return user;
  } catch {
    return null;
  }
}

export function hasAdminKey(req) {
  const expected = process.env.ADMIN_DASH_KEY;
  if (!expected) return false;
  const provided = req.headers['x-admin-key'];
  return Boolean(provided) && safeEqual(provided, expected);
}

/** Dedicated server-to-server guard for the image processor worker. */
export function hasImageProcessorSecret(req) {
  const expected = process.env.IMAGE_PROCESSOR_SECRET
    || process.env.CRON_SECRET
    || process.env.ADMIN_DASH_KEY;
  if (!expected) return false;
  const provided = String(
    req.headers['x-image-processor-secret']
    || req.headers['x-cron-secret']
    || '',
  ).trim();
  return Boolean(provided) && safeEqual(provided, expected);
}

function sendUnauthorized(res, message = 'Authentication required') {
  if (!res.headersSent) res.status(401).json({ error: message });
  return false;
}

function sendForbidden(res, message = 'Not authorized for admin access') {
  if (!res.headersSent) res.status(403).json({ error: message });
  return false;
}

/** Requires valid Supabase session for an allowlisted admin email. */
export async function requireAdminKey(req, res) {
  if (hasAdminKey(req)) return true;
  const token = extractBearerToken(req);
  if (!token) return sendUnauthorized(res);
  try {
    const supabase = getSupabaseAuthClient();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.email) return sendUnauthorized(res, 'Invalid or expired session');
    if (!isAdminEmail(user.email)) return sendForbidden(res);
    return true;
  } catch {
    return sendUnauthorized(res);
  }
}


/** Requires a verified Owner account for irreversible or site-wide operations. */
export async function requireOwner(req, res) {
  // ADMIN_DASH_KEY remains an emergency server-to-server break-glass credential.
  // It is not exposed by the browser application.
  if (hasAdminKey(req)) return true;
  const user = await verifyAdminUser(req);
  if (!user) return sendUnauthorized(res, 'Invalid or expired session');
  if (!isOwnerEmail(user.email)) return sendForbidden(res, 'Owner access is required for this operation');
  return true;
}

/**
 * A fulfillment link token, from the header the browser sets or — for a plain
 * page load that has not booted the app yet — the query string.
 */
export function extractFulfillmentToken(req) {
  const header = String(req.headers['x-fulfillment-token'] || '').trim();
  if (header) return header;
  const query = String(req.query?.ft || '').trim();
  if (query) return query;
  return String(req.body?.fulfillmentToken || '').trim();
}

export async function resolveRequestAuth(req) {
  if (hasAdminKey(req)) return { type: 'admin' };
  const admin = await verifyAdminUser(req);
  if (admin) return { type: 'admin', user: admin };
  const claim = verifyFulfillmentToken(extractFulfillmentToken(req));
  // `orderId` is what every scoped route checks its own order id against, so a
  // token minted for order A can never touch order B.
  return claim ? { type: 'order', orderId: claim.orderId, expiresAt: claim.expiresAt } : null;
}

/**
 * Fulfillment routes: a verified admin session, or a signed per-order link.
 * Routes that resolve an order-type auth MUST scope their work to
 * `auth.orderId` and refuse customer-facing or financial actions.
 */
export async function requireAdminOrOrderToken(req, res) {
  const auth = await resolveRequestAuth(req);
  if (auth) return auth;
  if (extractFulfillmentToken(req)) {
    return sendUnauthorized(res, 'This fulfilment link has expired or is no longer valid. Ask for a new one.');
  }
  return sendUnauthorized(res, 'Sign in to access fulfillment work');
}

/**
 * Guard for routes that share a fulfillment handler but must stay admin-only —
 * customer emails, the order-team notification round, and its log.
 */
export function requireAdminAuthType(auth, res, message = 'Sign in to the admin dashboard to do this.') {
  if (auth?.type === 'admin') return true;
  if (!res.headersSent) res.status(403).json({ error: message });
  return false;
}

/** Vercel cron secret or admin JWT. */
export async function requireCronOrAdminKey(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = String(
      req.headers['x-cron-secret']
      || req.headers['authorization']?.replace(/^Bearer\s+/i, '')
      || '',
    ).trim();
    if (provided && safeEqual(provided, cronSecret)) return true;
  }
  return requireAdminKey(req, res);
}

export function requireImageProcessor(req, res) {
  if (hasImageProcessorSecret(req)) return true;
  return sendUnauthorized(res, 'Valid image processor credentials are required');
}

/** Server-to-server trade registration (register / main portal) or admin session. */
export function hasTradeRegisterSecret(req) {
  const expected = process.env.TRADE_REGISTER_SECRET || process.env.ORDER_NOTIFY_SECRET;
  if (!expected) return false;
  const provided = String(req.headers['x-trade-register-secret'] || '').trim();
  return Boolean(provided) && safeEqual(provided, expected);
}

export async function requireTradeRegisterOrAdmin(req, res) {
  if (hasTradeRegisterSecret(req)) return true;
  if (hasAdminKey(req)) return true;
  return requireAdminKey(req, res);
}
