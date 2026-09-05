import { supabaseAuth } from './supabaseAuth';
import { OperationTimeoutError, withTimeout } from './asyncTimeout';

export const ADMIN_AUTH_TIMEOUT_MS = 10_000;

export const ADMIN_ROLES = Object.freeze({
  OWNER: 'owner',
  CUSTOMER_SERVICE: 'customer_service',
});

// Presentation mirror of the server-side role map. The server always makes
// the authorization decision; this only keeps the workspace focused.
const ADMIN_USERS = new Map([
  ['danieljoffeinfo@gmail.com', ADMIN_ROLES.OWNER],
  ['george@proto.co.za', ADMIN_ROLES.OWNER],
  ['online@proto.co.za', ADMIN_ROLES.OWNER],
]);

export const ADMIN_EMAILS = new Set(ADMIN_USERS.keys());

export function getAdminRole(email) {
  return ADMIN_USERS.get(String(email || '').trim().toLowerCase()) || null;
}

export function isAllowedAdminEmail(email) {
  return Boolean(getAdminRole(email));
}

export async function getSession() {
  const { data: { session }, error } = await supabaseAuth.auth.getSession();
  if (error) throw error;
  return session;
}

/** Validates JWT with Supabase — use on boot instead of getSession() alone. */
export async function getVerifiedSession() {
  const { data: { session }, error: sessionError } = await withTimeout(
    supabaseAuth.auth.getSession(),
    ADMIN_AUTH_TIMEOUT_MS,
    'Supabase did not return the admin session in time.',
    'admin_session_read_timeout',
  );
  if (sessionError) throw sessionError;
  if (!session?.access_token) return null;

  const { data: { user }, error } = await withTimeout(
    supabaseAuth.auth.getUser(),
    ADMIN_AUTH_TIMEOUT_MS,
    'Supabase did not verify the admin session in time.',
    'admin_session_timeout',
  );
  if (error) throw error;
  if (!user?.email) return null;
  if (!isAllowedAdminEmail(user.email)) {
    await supabaseAuth.auth.signOut();
    return null;
  }
  return session;
}

export async function verifyAdminSession() {
  try {
    const res = await fetch('/api/auth-check', {
      cache: 'no-store',
      signal: AbortSignal.timeout(ADMIN_AUTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch (error) {
    throw new OperationTimeoutError(
      'The admin authorization service did not respond in time.',
      error?.name === 'TimeoutError' ? 'admin_api_timeout' : 'admin_api_unavailable',
    );
  }
}

export async function getAccessToken() {
  const session = await getSession();
  return session?.access_token || '';
}

export async function signIn(email, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: String(email).trim().toLowerCase(),
    password,
  });
  if (error) throw error;
  if (!isAllowedAdminEmail(data.user?.email)) {
    await supabaseAuth.auth.signOut();
    throw new Error('This account is not authorized for the admin dashboard.');
  }
  return data.session;
}

export async function signOut() {
  const { error } = await supabaseAuth.auth.signOut();
  if (error) throw error;
}

export async function requestPasswordReset(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email is required');
  if (!isAllowedAdminEmail(normalized)) {
    throw new Error('This email is not authorized for the admin dashboard.');
  }
  const res = await fetch('/api/admin-forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalized }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
}

export function onAuthStateChange(callback) {
  return supabaseAuth.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}
