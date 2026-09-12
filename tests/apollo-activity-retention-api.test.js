import { describe, expect, it, vi } from 'vitest';
import { createActivityRetentionHandler } from '../api/apollo-activity-retention.js';

function request(method = 'POST', { headers = {}, body } = {}) { return { method, headers, body }; }
function response() { return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }; }
function handler(overrides = {}) {
  return createActivityRetentionHandler({
    enabled: () => true,
    requireOwnerAccess: vi.fn(async () => true),
    cronSecret: () => '',
    client: () => ({ rpc: vi.fn(async () => ({ data: { raw_removed: 4, monthly_removed: 2 }, error: null })) }),
    ...overrides,
  });
}

describe('Apollo activity retention endpoint', () => {
  it('is feature-disabled before authorisation or database initialisation', async () => {
    const client = vi.fn(); const owner = vi.fn(); const res = response();
    await handler({ enabled: () => false, client, requireOwnerAccess: owner })(request(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(owner).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('only accepts a payload-free POST', async () => {
    const client = vi.fn(); const owner = vi.fn();
    for (const req of [request('GET'), request('POST', { body: { force: true } })]) {
      const res = response(); await handler({ client, requireOwnerAccess: owner })(req, res);
      expect(res.status).toHaveBeenCalledWith(req.method === 'GET' ? 405 : 400);
    }
    expect(owner).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('requires an owner when no dedicated retention cron secret is supplied', async () => {
    const owner = vi.fn(async () => false); const client = vi.fn(); const res = response();
    await handler({ requireOwnerAccess: owner, client })(request(), res);
    expect(owner).toHaveBeenCalledOnce();
    expect(client).not.toHaveBeenCalled();
  });

  it('executes only the fixed retention RPC after owner approval', async () => {
    const rpc = vi.fn(async () => ({ data: { raw_removed: 4, monthly_removed: 2 }, error: null })); const res = response();
    await handler({ client: () => ({ rpc }) })(request('POST', { body: {} }), res);
    expect(rpc).toHaveBeenCalledWith('apollo_retain_activity');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, rawRemoved: 4, monthlyRemoved: 2 });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('permits only the dedicated matching cron secret without an owner session', async () => {
    const owner = vi.fn(); const rpc = vi.fn(async () => ({ data: { raw_removed: 0, monthly_removed: 0 }, error: null })); const res = response();
    await handler({ cronSecret: () => 'separate-secret', requireOwnerAccess: owner, client: () => ({ rpc }) })(request('POST', { headers: { 'x-apollo-activity-retention-secret': 'separate-secret' } }), res);
    expect(owner).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('redacts database failures and rejects malformed RPC results', async () => {
    for (const result of [{ data: null, error: { message: 'private diagnostic' } }, { data: { raw_removed: -1, monthly_removed: 0 }, error: null }]) {
      const res = response();
      await handler({ client: () => ({ rpc: vi.fn(async () => result) }) })(request(), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('private diagnostic');
    }
  });
});
