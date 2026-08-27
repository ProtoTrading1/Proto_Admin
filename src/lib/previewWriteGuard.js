const PRODUCTION_HOSTS = new Set([
  'admin.proto.co.za',
  'protoportal-admin-proto-team.vercel.app',
]);

export function isReadOnlyPreviewHost(hostname = '') {
  const host = String(hostname).trim().toLowerCase();
  return host.endsWith('.vercel.app') && !PRODUCTION_HOSTS.has(host);
}

export function shouldBlockPreviewRequest({ hostname = '', origin = '', url = '', method = 'GET' } = {}) {
  if (!isReadOnlyPreviewHost(hostname)) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) return false;

  try {
    const target = new URL(String(url), origin);
    return target.origin === origin && target.pathname.startsWith('/api/');
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

    if (shouldBlockPreviewRequest({
      hostname: window.location.hostname,
      origin: window.location.origin,
      url,
      method,
    })) {
      return new Response(JSON.stringify({ error: 'This preview is read-only. Nothing was changed.' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }

    return authenticatedFetch(input, init);
  };
}
