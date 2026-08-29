const PRODUCTION_PORTAL_REF = 'kyodrsqnmihwoplkhwwf';

export function previewAnalyticsGatewayEnabled(env = process.env) {
  if (String(env.VERCEL_ENV || '').toLowerCase() !== 'preview') return false;
  if (env.ANALYTICS_PREVIEW_WRITES_ENABLED !== 'true') return false;
  const ref = String(env.ANALYTICS_PREVIEW_PROJECT_REF || '').trim();
  if (!/^[a-z]{20}$/.test(ref) || ref === PRODUCTION_PORTAL_REF) return false;
  if (!env.ANALYTICS_PREVIEW_GATEWAY_SECRET) return false;
  try {
    const url = new URL(env.ANALYTICS_PREVIEW_GATEWAY_URL);
    return url.protocol === 'https:'
      && url.hostname === `${ref}.supabase.co`
      && url.pathname.startsWith('/functions/v1/proto-analytics-preview-gateway');
  } catch {
    return false;
  }
}

export async function callPreviewAnalyticsGateway(action, payload = {}, env = process.env) {
  if (!previewAnalyticsGatewayEnabled(env)) throw new Error('Isolated analytics preview gateway is not configured');
  const response = await fetch(env.ANALYTICS_PREVIEW_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-preview-analytics-secret': env.ANALYTICS_PREVIEW_GATEWAY_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Preview analytics gateway returned ${response.status}`);
  return body;
}
