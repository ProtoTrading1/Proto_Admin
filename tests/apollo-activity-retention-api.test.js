import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
      expect(res.status).toHaveBeenCalledWith(req.method === 'GET' ? 401 : req.method === 'POST' ? 400 : 405);
    }
    expect(owner).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('requires the Vercel cron bearer secret for scheduled GET requests', async () => {
    const owner = vi.fn(); const client = vi.fn();
    const target = handler({ cronSecret: () => 'expected-cron-secret', requireOwnerAccess: owner, client });
    const denied = response();
    await target(request('GET', { headers: { authorization: 'Bearer wrong-secret' } }), denied);
    expect(denied.status).toHaveBeenCalledWith(401);
    expect(owner).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();

    const rpc = vi.fn(async () => ({ data: { raw_removed: 0, monthly_removed: 0 }, error: null }));
    const accepted = response();
    await handler({ cronSecret: () => 'expected-cron-secret', requireOwnerAccess: owner, client: () => ({ rpc }) })(
      request('GET', { headers: { authorization: 'Bearer expected-cron-secret' } }), accepted,
    );
    expect(accepted.status).toHaveBeenCalledWith(200);
    expect(rpc).toHaveBeenCalledWith('apollo_retain_activity');
  });

  it('uses Vercel CRON_SECRET by default and has one daily UTC schedule', async () => {
    const oldSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'vercel-cron-secret';
    try {
      const rpc = vi.fn(async () => ({ data: { raw_removed: 0, monthly_removed: 0 }, error: null }));
      const res = response();
      await createActivityRetentionHandler({ enabled: () => true, client: () => ({ rpc }), requireOwnerAccess: vi.fn() })(
        request('GET', { headers: { authorization: 'Bearer vercel-cron-secret' } }), res,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(rpc).toHaveBeenCalledOnce();

      const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
      expect(config.crons.filter(row => row.path === '/api/apollo-activity-retention')).toEqual([
        { path: '/api/apollo-activity-retention', schedule: '30 1 * * *' },
      ]);
    } finally {
      if (oldSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = oldSecret;
    }
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

