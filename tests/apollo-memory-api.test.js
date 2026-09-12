import { describe, expect, it, vi } from 'vitest';
import { createMemoryHandler } from '../api/apollo-memory.js';

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' };
const req = (method, body) => ({ method, body, query: {} });
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() });
const row = { key: 'k', kind: 'definition', title: 'T', body: 'B', evidence_refs: ['r'], reviewer: user.id, version: 1, state: 'approved' };
function dbMock() { return { rpc: vi.fn() }; }

describe('Apollo memory API contract', () => {
  it('rejects non-owner before client creation', async () => { const client = vi.fn(); const response = res(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => false, client, enabled: () => true })(req('GET'), response); expect(response.status).toHaveBeenCalledWith(403); expect(client).not.toHaveBeenCalled(); });
  it('rejects unsupported methods', async () => { const response = res(); await createMemoryHandler({ verify: vi.fn(), client: vi.fn() })(req('DELETE'), response); expect(response.status).toHaveBeenCalledWith(405); });
  it('authenticates before reads', async () => { const db = dbMock(); const response = res(); await createMemoryHandler({ verify: vi.fn(async () => null), client: () => db, enabled: () => true })(req('GET'), response); expect(response.status).toHaveBeenCalledWith(401); expect(db.rpc).not.toHaveBeenCalled(); });
  it('returns disabled without creating a client', async () => { const response = res(); const client = vi.fn(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client, enabled: () => false })(req('GET'), response); expect(response.status).toHaveBeenCalledWith(404); expect(client).not.toHaveBeenCalled(); });
  it('injects server UUID into exact RPC args', async () => { const rpc = vi.fn(async () => ({ data: row, error: null })); const db = { rpc }; const response = res(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client: () => db, enabled: () => true })(req('POST', { key: 'k', kind: 'definition', title: 'T', body: 'B', evidenceRefs: ['r'], state: 'approved', expectedVersion: 0 }), response); expect(rpc.mock.calls[0][1]).toMatchObject({ p_reviewer: user.id, p_expected_version: 0 }); expect(rpc.mock.calls[0][1].reviewer).toBeUndefined(); });
  it('uses exact RPC name', async () => { const rpc = vi.fn(async () => ({ data: row, error: null })); const response = res(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client: () => ({ rpc }), enabled: () => true })(req('POST', { key: 'k', kind: 'definition', title: 'T', body: 'B', evidenceRefs: ['r'], state: 'approved', expectedVersion: 0 }), response); expect(rpc).toHaveBeenCalledWith('apollo_append_memory', expect.any(Object)); });
  it('rejects invalid query before client creation', async () => { const client = vi.fn(); const response = res(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client, enabled: () => true })(Object.assign(req('GET'), { query: { version: 'nope' } }), response); expect(response.status).toHaveBeenCalledWith(400); expect(client).not.toHaveBeenCalled(); });
  it('rejects an invalid page cursor or size before client creation', async () => {
    const client = vi.fn();
    for (const query of [{ cursor: 'not a key' }, { limit: '101' }, { limit: '1.5' }]) {
      const response = res();
      await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client, enabled: () => true })(Object.assign(req('GET'), { query }), response);
      expect(response.status).toHaveBeenCalledWith(400);
    }
    expect(client).not.toHaveBeenCalled();
  });
  it('rejects array body without RPC', async () => { const rpc = vi.fn(); const response = res(); await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client: () => ({ rpc }), enabled: () => true })(req('POST', []), response); expect(response.status).toHaveBeenCalledWith(400); expect(rpc).not.toHaveBeenCalled(); });
  it('returns only reviewed current memory content on a successful read', async () => {
    const revisions = [row, { ...row, version: 2, state: 'draft', body: 'Unreviewed' }];
    const rpc = vi.fn(async () => ({ data: revisions, error: null }));
    const response = res();
    await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client: () => ({ rpc }), enabled: () => true })(req('GET'), response);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(rpc).toHaveBeenCalledWith('apollo_read_memory', { p_after_key: null, p_limit: 50 });
    expect(response.json).toHaveBeenCalledWith({ memories: [], nextCursor: null });
  });
  it('uses a key cursor without splitting a selected revision history', async () => {
    const revisions = [{ ...row, key: 'next', title: 'Next', version: 1 }, { ...row, key: 'next', title: 'Next revised', version: 2 }];
    const rpc = vi.fn(async () => ({ data: revisions, error: null }));
    const response = res(); const request = Object.assign(req('GET'), { query: { cursor: 'k', limit: '1' } });
    await createMemoryHandler({ verify: vi.fn(async () => user), owner: () => true, client: () => ({ rpc }), enabled: () => true })(request, response);
    expect(rpc).toHaveBeenCalledWith('apollo_read_memory', { p_after_key: 'k', p_limit: 1 });
    expect(response.json).toHaveBeenCalledWith({ memories: [{ key: 'next', kind: 'definition', title: 'Next revised', body: 'B', evidenceRefs: ['r'], version: 2, state: 'approved' }], nextCursor: 'next' });
  });
});
