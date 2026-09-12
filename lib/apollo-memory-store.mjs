import { validateMemoryDefinition, validateMemorySet } from './apollo-memory.mjs';

const CLIENT_KEYS = new Set(['key', 'kind', 'title', 'body', 'evidenceRefs', 'state']);
const DB_KEYS = new Set(['key', 'kind', 'title', 'body', 'evidence_refs', 'reviewer', 'version', 'state', 'recorded_at']);
const fail = (message) => { const e = new Error(message); e.code = 'INVALID_MEMORY_STORE'; return e; };

/** Caller must have already authenticated/authorized serverUserId. */
export function prepareMemoryRpcArgs(payload = {}, { serverUserId, expectedVersion = null } = {}) {
  if (typeof serverUserId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serverUserId.trim())) throw fail('Authenticated server reviewer UUID is required');
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) throw fail('Payload must be a plain object');
  const unknown = Object.keys(payload).filter((key) => !CLIENT_KEYS.has(key));
  if (unknown.length) throw fail(`Unknown client fields: ${unknown.join(', ')}`);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483646) throw fail('expectedVersion must be a non-negative SQL integer');
  for (const key of ['key', 'kind', 'title', 'body', 'evidenceRefs', 'state']) if (!(key in payload)) throw fail(`Missing client field: ${key}`);
  const reviewer = serverUserId.trim();
  const normalized = validateMemoryDefinition({ ...payload, reviewer, version: expectedVersion + 1 }, { serverReviewer: reviewer });
  return { p_key: normalized.key, p_expected_version: expectedVersion, p_kind: normalized.kind, p_title: normalized.title, p_body: normalized.body, p_evidence_refs: normalized.evidenceRefs, p_state: normalized.state, p_reviewer: reviewer };
}

export function dbRowToMemory(row = {}) {
  if (!row || Object.getPrototypeOf(row) !== Object.prototype) throw fail('DB row must be a plain object');
  const unknown = Object.keys(row).filter((key) => !DB_KEYS.has(key));
  if (unknown.length) throw fail(`Unexpected DB fields: ${unknown.join(', ')}`);
  return { key: row.key, kind: row.kind, title: row.title, body: row.body, evidenceRefs: row.evidence_refs, reviewer: row.reviewer, version: row.version, state: row.state };
}

export function buildMemoryReadAdapter(rows = []) {
  if (!Array.isArray(rows)) throw fail('DB rows must be an array');
  const memories = rows.map(dbRowToMemory);
  validateMemorySet(memories);
  return memories;
}
