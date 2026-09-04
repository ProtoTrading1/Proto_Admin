import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { client, rpc, gateway } = vi.hoisted(() => ({ client: vi.fn(), rpc: vi.fn(), gateway: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: client }));
vi.mock('../api/_analytics-preview-gateway.js', async (original) => ({ ...(await original()), callPreviewAnalyticsGateway: gateway }));
import handler from '../api/codex-analytics-worker.js';

function response() { return { setHeader: vi.fn(), status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
const request = (action = 'claim') => ({ method: 'POST', headers: { 'x-codex-worker-secret': 'test-worker-only' }, body: { action, workerId: 'test-worker' } });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CODEX_ANALYTICS_WORKER_SECRET', 'test-worker-only');
  vi.stubEnv('ANALYTICS_PREVIEW_WRITES_ENABLED', 'false');
  client.mockReturnValue({ rpc });
  rpc.mockResolvedValue({ data: [], error: null });
  gateway.mockResolvedValue({ job: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('Apollo worker production isolation', () => {
  it.each(['preview', 'development', ''])('does not touch a database in unapproved runtime %j', async (runtime) => {
    vi.stubEnv('VERCEL_ENV', runtime);
    for (const action of ['claim', 'complete', 'fail']) {
      const res = response();
      await handler(request(action), res);
      expect(res.code).toBe(409);
    }
    expect(client).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });
  it('rejects a preview whose gateway points at the production project', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('ANALYTICS_PREVIEW_WRITES_ENABLED', 'true');
    vi.stubEnv('ANALYTICS_PREVIEW_PROJECT_REF', 'kyodrsqnmihwoplkhwwf');
    vi.stubEnv('ANALYTICS_PREVIEW_GATEWAY_SECRET', 'test');
    vi.stubEnv('ANALYTICS_PREVIEW_GATEWAY_URL', 'https://kyodrsqnmihwoplkhwwf.supabase.co/functions/v1/proto-analytics-preview-gateway');
    const res = response();
    await handler(request(), res);
    expect(res.code).toBe(409);
    expect(client).not.toHaveBeenCalled();
  });
  it('uses only the isolated gateway for an approved preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('ANALYTICS_PREVIEW_WRITES_ENABLED', 'true');
    vi.stubEnv('ANALYTICS_PREVIEW_PROJECT_REF', 'xicygaamdogfdpzyrlcp');
    vi.stubEnv('ANALYTICS_PREVIEW_GATEWAY_SECRET', 'test');
    vi.stubEnv('ANALYTICS_PREVIEW_GATEWAY_URL', 'https://xicygaamdogfdpzyrlcp.supabase.co/functions/v1/proto-analytics-preview-gateway');
    const res = response();
    await handler(request(), res);
    expect(res.code).toBe(200);
    expect(gateway).toHaveBeenCalledWith('claim', expect.any(Object));
    expect(client).not.toHaveBeenCalled();
  });
  it('preserves authenticated production claiming', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const res = response();
    await handler(request(), res);
    expect(res.code).toBe(200);
    expect(rpc).toHaveBeenCalledWith('claim_codex_analytics_job', expect.any(Object));
  });
  it('rejects incorrect authentication without any database calls', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const res = response();
    await handler({ ...request(), headers: {} }, res);
    expect(res.code).toBe(401);
    expect(client).not.toHaveBeenCalled();
  });
  it('rejects unknown actions before constructing a client', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const res = response();
    await handler(request('delete-everything'), res);
    expect(res.code).toBe(400);
    expect(client).not.toHaveBeenCalled();
  });
});
