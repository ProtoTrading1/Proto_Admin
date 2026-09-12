import { describe, expect, it } from 'vitest';
import { buildMemoryReadAdapter, dbRowToMemory, prepareMemoryRpcArgs } from '../lib/apollo-memory-store.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';
const row = { key: 'k', kind: 'definition', title: 'T', body: 'B', evidence_refs: ['ref'], reviewer: UUID, version: 1, state: 'approved' };
describe('Apollo memory store adapter', () => {
  it('injects authenticated reviewer and never trusts client reviewer', () => {
    const args = prepareMemoryRpcArgs({ key: 'k', kind: 'definition', title: 'T', body: 'B', evidenceRefs: ['ref'], state: 'approved' }, { serverUserId: UUID, expectedVersion: 0 });
    expect(args.p_reviewer).toBe(UUID); expect(args.p_expected_version).toBe(0); expect(args.p_version).toBeUndefined();
  });
  it('whitelists client fields and requires server identity', () => {
    expect(() => prepareMemoryRpcArgs({ key: 'k', kind: 'definition', title: 'T', body: 'B', evidenceRefs: ['ref'], state: 'approved', reviewer: 'evil' }, { serverUserId: UUID, expectedVersion: 0 })).toThrow(/unknown/i);
    expect(() => prepareMemoryRpcArgs({}, { serverUserId: UUID })).toThrow(/expectedVersion/i);
  });
  it('normalizes DB evidence_refs and reviewer', () => { expect(dbRowToMemory(row)).toMatchObject({ evidenceRefs: ['ref'], reviewer: UUID }); });
  it('validates complete histories and rejects duplicate key/version', () => {
    expect(buildMemoryReadAdapter([row])).toHaveLength(1);
    expect(() => buildMemoryReadAdapter([row, row])).toThrow(/duplicate|conflicting/i);
  });
  it('passes expectedVersion for optimistic RPC guards', () => { expect(prepareMemoryRpcArgs({ key: 'k', kind: 'definition', title: 'T', body: 'B', evidenceRefs: ['ref'], state: 'approved' }, { serverUserId: UUID, expectedVersion: 2 }).p_expected_version).toBe(2); });
  it('validates the browser fields before forming server RPC arguments', () => {
    const payload = { key: 'not legal spaces', kind: 'live_fact', title: '', body: 'B', evidenceRefs: [], state: 'approved' };
    expect(() => prepareMemoryRpcArgs(payload, { serverUserId: UUID, expectedVersion: 0 })).toThrow();
  });
});
