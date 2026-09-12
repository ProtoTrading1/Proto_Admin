import { describe, expect, it } from 'vitest';
import { assertVersionAdvance, retrieveApprovedMemories, validateMemoryDefinition, validateMemorySet } from '../lib/apollo-memory.mjs';

const memory = (overrides = {}) => ({ key: 'returns-policy', kind: 'definition', title: 'Returns policy', body: 'Inspect approved policy.', evidenceRefs: ['doc:returns:1'], reviewer: 'server-user', version: 1, state: 'approved', ...overrides });

describe('Apollo approved memory contract', () => {
  it('does not resurrect approved text after a newer rejected version', () => {
    expect(retrieveApprovedMemories([memory(), memory({ version:2,state:'rejected' })])).toEqual([]);
  });
  it('does not find old matching text when current definition has changed', () => {
    expect(retrieveApprovedMemories([memory(),memory({version:2,body:'Replacement.',title:'Different',evidenceRefs:['doc:2']})],{query:'Inspect'})).toEqual([]);
  });
  it('fails closed for a newer draft and supports explicit historical approved retrieval', () => {
    const rows = [memory(),memory({version:2,state:'draft'})];
    expect(retrieveApprovedMemories(rows)).toEqual([]);
    expect(retrieveApprovedMemories(rows,{version:1})).toHaveLength(1);
    expect(retrieveApprovedMemories(rows,{version:2})).toEqual([]);
  });
  it('allows a different authorized reviewer to create the next version', () => {
    expect(assertVersionAdvance(memory(),memory({version:2,reviewer:'second-owner'}),{serverReviewer:'second-owner'}).reviewer).toBe('second-owner');
  });
  it('rejects mismatched reviewer and live fact memory kinds', () => {
    expect(()=>validateMemoryDefinition(memory(),{serverReviewer:'other'})).toThrow();
    expect(()=>validateMemoryDefinition(memory({kind:'live_fact'}),{serverReviewer:'server-user'})).toThrow();
  });
  it('rejects primitive coercions and oversized evidence arrays', () => {
    for (const change of [{version:true},{version:'1'},{title:{}},{evidenceRefs:[{}]},{evidenceRefs:Array(21).fill('doc:1')}]) {
      expect(()=>validateMemoryDefinition(memory(change),{serverReviewer:'server-user'})).toThrow();
    }
  });
  it('returns only allowlisted properties and reads memories from different reviewers', () => {
    expect(validateMemoryDefinition(memory({extra:'discard'}),{serverReviewer:'server-user'})).not.toHaveProperty('extra');
    expect(retrieveApprovedMemories([memory(),memory({key:'second',reviewer:'second-owner'})])).toHaveLength(2);
  });
  it('rejects malformed query/version instead of broadening retrieval', () => {
    expect(()=>retrieveApprovedMemories([memory()],{query:{}})).toThrow();
    expect(()=>retrieveApprovedMemories([memory()],{version:'1'})).toThrow();
  });
  it('requires evidence, valid lifecycle, version, and authenticated reviewer', () => {
    expect(validateMemoryDefinition(memory(), { serverReviewer: 'server-user' }).state).toBe('approved');
    expect(() => validateMemoryDefinition(memory({ evidenceRefs: [] }), { serverReviewer: 'server-user' })).toThrow(/evidence/i);
    expect(() => validateMemoryDefinition(memory({ state: 'published' }), { serverReviewer: 'server-user' })).toThrow(/state/i);
    expect(() => validateMemoryDefinition(memory())).toThrow(/serverReviewer/i);
  });
  it('retrieves approved records only and excludes superseded/unreviewed', () => {
    const rows = retrieveApprovedMemories([memory(), memory({ key: 'old', state: 'superseded' }), memory({ key: 'draft', state: 'draft' })]);
    expect(rows.map((row) => row.key)).toEqual(['returns-policy']);
  });
  it('rejects deterministic version conflicts and requires sequential updates', () => {
    expect(() => validateMemorySet([memory(), memory({ version: 1 })])).toThrow(/conflicting/i);
    expect(assertVersionAdvance(memory(), memory({ version: 2 }), { serverReviewer: 'server-user' }).version).toBe(2);
    expect(() => assertVersionAdvance(memory(), memory({ version: 3 }), { serverReviewer: 'server-user' })).toThrow(/exactly one/i);
  });
  it('rejects incomplete histories before retrieving approved memory', () => {
    const gap = [memory(), memory({ version: 3 })];
    expect(() => validateMemorySet(gap)).toThrow(/incomplete memory history/i);
    expect(() => retrieveApprovedMemories(gap)).toThrow(/incomplete memory history/i);
  });
  it('rejects kind changes within one memory history', () => {
    const drift = [memory(), memory({ version: 2, kind: 'decision' })];
    expect(() => validateMemorySet(drift)).toThrow(/kind changed/i);
    expect(() => retrieveApprovedMemories(drift)).toThrow(/kind changed/i);
  });
});
