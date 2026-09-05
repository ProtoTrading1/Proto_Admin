/** Patches window.fetch with the verified admin JWT, or a fulfillment link token. */
import { supabaseAuth } from './supabaseAuth';

/**
 * Where the fulfilment page gets its order from.
 *
 * `/f/<orderId>/<token>` is the signed link the team receives on WhatsApp: the
 * token authorizes that one order, so the page opens without an admin account.
 * `/fulfillment?id=<orderId>` (no token) is the admin's own route into the same
 * page and still requires a signed-in session.
 */
export function getOrderAccessFromUrl() {
  try {
    const path = window.location.pathname || '';
    const match = path.match(/^\/f\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (match) {
      return { orderId: decodeURIComponent(match[1]), token: match[2] ? decodeURIComponent(match[2]) : '' };
    }
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('o') || params.get('id') || '';
    const token = params.get('ft') || '';
    if (orderId) return { orderId, token };
  } catch { /* ignore */ }
  return { orderId: '', token: '' };
}

/** True when this page load is authorized by a link rather than a session. */
export function hasFulfillmentToken() {
  return Boolean(getOrderAccessFromUrl().token);
}

async function attachAuthHeaders(headers) {
  if (headers.has('Authorization')) return;
  // A link token is the whole credential — don't reach for a session that a
  // logged-out packer does not have.
  const { token } = getOrderAccessFromUrl();
  if (token) {
    headers.set('X-Fulfillment-Token', token);
    return;
  }
  try {
    const { data: { session } } = await supabaseAuth.auth.getSession();
    if (session?.access_token) {
      headers.set('Authorization', `Bearer ${session.access_token}`);
      return;
    }
    const { data } = await supabaseAuth.auth.refreshSession();
    if (data.session?.access_token) {
      headers.set('Authorization', `Bearer ${data.session.access_token}`);
    }
  } catch { /* ignore */ }
}

export function installAuthFetch() {
  if (window.__protoAuthFetchInstalled) return;
  window.__protoAuthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isApiCall = url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
    if (!isApiCall) return originalFetch(input, init);

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});

    await attachAuthHeaders(headers);

    let response = await originalFetch(input, { ...init, headers });

    // A link-authorized page has no session to refresh and no login to bounce
    // to — its 401 means the link expired, which the page reports itself.
    const linkMode = hasFulfillmentToken();

    if (response.status === 401 && !linkMode && !getOrderAccessFromUrl().orderId) {
      try {
        const { data } = await supabaseAuth.auth.refreshSession();
        if (data.session?.access_token) {
          headers.set('Authorization', `Bearer ${data.session.access_token}`);
          response = await originalFetch(input, { ...init, headers });
        }
      } catch { /* ignore */ }
    }

    if (!linkMode && !getOrderAccessFromUrl().orderId) {
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent('proto-admin-unauthorized'));
      } else if (response.status === 403) {
        window.dispatchEvent(new CustomEvent('proto-admin-forbidden'));
      }
    }

    return response;
  };
}
