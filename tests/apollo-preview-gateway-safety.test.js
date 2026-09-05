import { afterEach, describe, expect, it, vi } from 'vitest';
import { callPreviewAnalyticsGateway, directAnalyticsDataEnabled, isolatedPreviewDatabaseEnabled, previewAnalyticsGatewayEnabled } from '../api/_analytics-preview-gateway.js';
const url = 'https://xicygaamdogfdpzyrlcp.supabase.co/functions/v1/proto-analytics-preview-gateway';
const env = { VERCEL_ENV: 'preview', ANALYTICS_PREVIEW_WRITES_ENABLED: 'true', ANALYTICS_PREVIEW_PROJECT_REF: 'xicygaamdogfdpzyrlcp', ANALYTICS_PREVIEW_GATEWAY_SECRET: 'test-only', ANALYTICS_PREVIEW_GATEWAY_URL: url };
afterEach(() => vi.unstubAllGlobals());
describe('isolated preview gateway destination', () => {
  it('rejects a valid-looking but unapproved Supabase project', () => {
    const otherRef = 'abcdefghijklmnopqrst';
    expect(previewAnalyticsGatewayEnabled({
      ...env,
      ANALYTICS_PREVIEW_PROJECT_REF: otherRef,
      ANALYTICS_PREVIEW_GATEWAY_URL: `https://${otherRef}.supabase.co/functions/v1/proto-analytics-preview-gateway`,
    })).toBe(false);
  });
  it.each([`${url}-other`, `${url}?redirect=elsewhere`, `${url}#fragment`, url.replace('https://', 'https://user:pass@'), url.replace('.co/', '.co:444/')])('rejects unexpected destination %s', (destination) => {
    expect(previewAnalyticsGatewayEnabled({ ...env, ANALYTICS_PREVIEW_GATEWAY_URL: destination })).toBe(false);
  });
  it('allows direct preview reads only when the database is the same approved isolated project', () => {
    expect(isolatedPreviewDatabaseEnabled({ ...env, VITE_SUPABASE_URL: 'https://xicygaamdogfdpzyrlcp.supabase.co' })).toBe(true);
    expect(directAnalyticsDataEnabled({ ...env, VITE_SUPABASE_URL: 'https://kyodrsqnmihwoplkhwwf.supabase.co' })).toBe(false);
    expect(directAnalyticsDataEnabled({ ...env, VITE_SUPABASE_URL: 'https://another-project.supabase.co' })).toBe(false);
    expect(directAnalyticsDataEnabled({ VERCEL_ENV: 'production' })).toBe(true);
  });
  it('uses the exact approved endpoint without redirects and with a timeout', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job: null }) });
    vi.stubGlobal('fetch', fetch);
    await expect(callPreviewAnalyticsGateway('claim', {}, env)).resolves.toEqual({ job: null });
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
});
