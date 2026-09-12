/** Pure contract. Authentication/authorization happens before calling this module. */
const STATES = new Set(['draft', 'approved', 'superseded', 'rejected']);
const KINDS = new Set(['definition', 'decision']);
const MAX = { key: 120, title: 240, body: 10000, ref: 500 };
function invalid(message) { const e = new Error(message); e.code = 'INVALID_MEMORY'; return e; }
function text(v, name, max) { if (typeof v !== 'string' || !v.trim() || v.length > max) throw invalid(`${name} must be a nonblank string within ${max} characters`); return v.trim(); }
function stored(input = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalid('Memory must be a plain object');
  const key = text(input.key, 'key', MAX.key); const title = text(input.title, 'title', MAX.title); const body = text(input.body, 'body', MAX.body);
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(key)) throw invalid('Invalid stable memory key');
  if (!KINDS.has(input.kind)) throw invalid('kind must be definition or decision');
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 2147483647) throw invalid('version must be a positive SQL integer');
  if (!STATES.has(input.state)) throw invalid('Invalid memory state');
  if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 20 || input.evidenceRefs.some((r) => typeof r !== 'string' || !r.trim() || r.length > MAX.ref)) throw invalid('evidenceRefs must contain bounded nonblank strings');
  const reviewer = text(input.reviewer, 'reviewer', 240);
  return { key, kind: input.kind, title, body, evidenceRefs: input.evidenceRefs.map((r) => r.trim()), reviewer, version: input.version, state: input.state };
}
export function validateMemoryDefinition(input, { serverReviewer } = {}) { if (typeof serverReviewer !== 'string' || !serverReviewer.trim()) throw invalid('serverReviewer is required from authenticated server context'); const row = stored(input); if (row.reviewer !== serverReviewer.trim()) throw invalid('reviewer does not match authenticated server reviewer'); return row; }
export function validateMemorySet(records = []) {
  if (!Array.isArray(records)) throw invalid('Memory records must be an array');
  const rows = records.map(stored); const histories = new Map();
  for (const row of rows) {
    const history = histories.get(row.key) || { kind: row.kind, versions: new Set() };
    if (history.kind !== row.kind) throw invalid(`Memory kind changed within history: ${row.key}`);
    if (history.versions.has(row.version)) throw invalid(`Conflicting memory version: ${row.key}@${row.version}`);
    history.versions.add(row.version); histories.set(row.key, history);
  }
  for (const [key, history] of histories) {
    const versions = [...history.versions].sort((a,b) => a-b);
    for (let index = 0; index < versions.length; index += 1) {
      if (versions[index] !== index + 1) throw invalid(`Incomplete memory history: ${key}@${index+1}`);
    }
  }
  return rows;
}
// Fail closed: a newer draft/rejection/supersession suppresses older approved
// facts. Explicit historical retrieval must be labeled historical by its caller.
export function retrieveApprovedMemories(records = [], { query = '', version = null } = {}) {
  if (typeof query !== 'string' || query.length > 500) throw invalid('Invalid memory query');
  if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw invalid('Invalid historical version');
  // Retrieval requires complete per-key histories so a missing newer rejection,
  // draft or supersession can never resurrect an older approved statement.
  const rows = validateMemorySet(records); const byKey = new Map();
  for (const row of rows) {
    if (version !== null && row.version !== version) continue;
    const prior = byKey.get(row.key);
    if (!prior || row.version > prior.version) byKey.set(row.key, row);
  }
  const needle = query.trim().toLowerCase();
  return [...byKey.values()].filter(row => row.state === 'approved')
    .filter(row => !needle || `${row.title} ${row.body} ${row.evidenceRefs.join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => a.key.localeCompare(b.key));
}
export function assertVersionAdvance(previous, next, { serverReviewer } = {}) {
  const oldRow = stored(previous);
  const nextRow = validateMemoryDefinition(next, { serverReviewer });
  if (oldRow.key !== nextRow.key || oldRow.kind !== nextRow.kind) throw invalid('Version guard requires the same key and kind');
  if (nextRow.version !== oldRow.version + 1) throw invalid('Memory version must advance by exactly one');
  // Database caller must lock/check the stored current version atomically.
  // This pure validation alone is not a concurrency or authorization boundary.
  return nextRow;
}
