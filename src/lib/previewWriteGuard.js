const PRODUCTION_HOSTS = new Set([
  'admin.proto.co.za',
  'protoportal-admin-proto-team.vercel.app',
]);

// Keep this in sync with the server middleware's audited read POST allowlist.
const READ_ONLY_PREVIEW_POST_PATHS = new Set([
  '/api/auth-check',
  '/api/product-loader-batch-lookup',
  '/api/nutstore-batch-lookup',
  '/api/product-loader-variant-preview',
]);
const READ_ONLY_STOCK_ACTIONS = new Set(['listLive', 'listArchived']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseBody(body) {
  if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return body;
  if (typeof body !== 'string' || body.length > 65536) return null;
  try { return JSON.parse(body); } catch { return null; }
}

export function isReadOnlyPreviewHost(hostname = '') {
  const host = String(hostname).trim().toLowerCase();
  return host.endsWith('.vercel.app') && !PRODUCTION_HOSTS.has(host);
}

export function shouldBlockPreviewRequest({ hostname = '', origin = '', url = '', method = 'GET', body = null } = {}) {
  if (!isReadOnlyPreviewHost(hostname)) return false;
  const verb = String(method).toUpperCase();
  if (!MUTATING_METHODS.has(verb)) return false;

  try {
    const target = new URL(String(url), origin);
    const pathname = target.pathname;
    if (target.origin === origin && pathname.startsWith('/api/')) {
      if (verb === 'POST' && READ_ONLY_PREVIEW_POST_PATHS.has(pathname)) return false;
      if (verb === 'POST' && pathname === '/api/stock-actions') {
        try {
          if (READ_ONLY_STOCK_ACTIONS.has(parseBody(body)?.action)) return false;
        } catch { /* malformed or hostile body objects stay blocked */ }
      }
      return true;
    }
    if (target.origin !== origin && /^\/(?:rest|storage)\/v1(?:\/|$)/.test(pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function installPreviewWriteGuard() {
  if (typeof window === 'undefined' || window.__protoPreviewWriteGuardInstalled) return;
  if (!isReadOnlyPreviewHost(window.location.hostname)) return;

  window.__protoPreviewWriteGuardInstalled = true;
  const authenticatedFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = init.method || (typeof input !== 'string' ? input?.method : '') || 'GET';
    let body = Object.hasOwn(init, 'body') ? init.body : null;
    if (body == null && String(method).toUpperCase() === 'POST' && input instanceof Request) {
      try { body = await input.clone().text(); } catch { body = null; }
    }

    if (shouldBlockPreviewRequest({
      hostname: window.location.hostname,
      origin: window.location.origin,
      url,
      method,
      body,
    })) {
      return new Response(JSON.stringify({ error: 'This preview is read-only. Nothing was changed.' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }

    return authenticatedFetch(input, init);
  };
}
