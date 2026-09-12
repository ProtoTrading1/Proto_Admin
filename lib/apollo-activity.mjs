// Server-side interval aggregation. Identity must come from authenticated storage,
// never browser-provided customer IDs. Sources remain separate; combined time is
// a fresh union, not the sum of Main and Instore totals.
const SOURCES = new Set(['main', 'instore']);
function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new TypeError('Timestamp requires an explicit timezone');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError('Invalid timestamp');
  return result;
}
function unionMilliseconds(intervals) {
  let total = 0; let start = null; let end = null;
  for (const [a, b] of intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (start === null) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return total + (start === null ? 0 : end - start);
}
function coversWindow(coverage, source, lower, upper) {
  const row = coverage?.[source];
  if (!row || row.verified !== true) return false;
  try { return timestamp(row.start) <= lower && timestamp(row.end) >= upper; } catch { return false; }
}
export function aggregateActiveIntervals(records, { start, end, coverage = {} } = {}) {
  const lower = timestamp(start); const upper = timestamp(end);
  if (upper <= lower || !Array.isArray(records)) throw new TypeError('Invalid reporting window or records');
  const covered = { main: coversWindow(coverage, 'main', lower, upper), instore: coversWindow(coverage, 'instore', lower, upper) };
  const people = new Map(); const seen = new Map(); let rejected = 0; let duplicates = 0;
  for (const record of records) {
    try {
      if (!record || typeof record.customer_id !== 'string' || !record.customer_id.trim() ||
          typeof record.event_id !== 'string' || !record.event_id.trim() || !SOURCES.has(record.source)) throw new TypeError('Identity or source missing');
      const a = timestamp(record.start_at); const b = timestamp(record.end_at);
      if (b <= a || b - a > 60000) throw new TypeError('Invalid active slice');
      const signature = JSON.stringify([record.customer_id, record.source, a, b]);
      if (seen.has(record.event_id)) {
        if (seen.get(record.event_id) !== signature) throw new TypeError('Conflicting event ID');
        duplicates += 1; continue;
      }
      seen.set(record.event_id, signature);
      const clipped = [Math.max(a, lower), Math.min(b, upper)];
      if (clipped[1] <= clipped[0]) continue;
      const person = people.get(record.customer_id) || { main: [], instore: [] };
      person[record.source].push(clipped); people.set(record.customer_id, person);
    } catch { rejected += 1; }
  }
  const customers = [...people].map(([customerId, intervals]) => ({ customerId,
    mainSeconds: intervals.main.length || covered.main ? unionMilliseconds([...intervals.main]) / 1000 : null,
    instoreSeconds: intervals.instore.length || covered.instore ? unionMilliseconds([...intervals.instore]) / 1000 : null,
    activeSeconds: unionMilliseconds([...intervals.main, ...intervals.instore]) / 1000,
  })).sort((a, b) => a.customerId.localeCompare(b.customerId));
  const collectionVerified = covered.main && covered.instore;
  return { source: 'apollo_activity_events', start, end, estimated: true,
    coverage: covered, complete: collectionVerified && rejected === 0,
    activeSeconds: customers.length || collectionVerified ? customers.reduce((sum, c) => sum + c.activeSeconds, 0) : null,
    customers, rejectedRecords: rejected, duplicateRecords: duplicates };
}

// Converts the private event-table shape to the union calculator input. It is
// intentionally strict: malformed payloads are reported as rejected, never
// interpreted as zero activity. This is server-side only.
export function activityEventRowsToIntervals(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('Activity rows must be an array');
  const intervals = [];
  let rejected = 0;
  for (const row of rows) {
    try {
      if (!row || row.event_type !== 'active_interval' ||
          typeof row.payload !== 'object' || Array.isArray(row.payload) ||
          Object.keys(row.payload).length !== 3 ||
          !Object.hasOwn(row.payload, 'start_at') || !Object.hasOwn(row.payload, 'end_at') ||
          !Object.hasOwn(row.payload, 'seconds')) throw new TypeError('Invalid active event');
      const start = timestamp(row.payload.start_at);
      const end = timestamp(row.payload.end_at);
      if (!Number.isSafeInteger(row.payload.seconds) || row.payload.seconds < 1 ||
          row.payload.seconds > 60 || end <= start || end - start > 60000 ||
          Math.floor((end - start) / 1000) !== row.payload.seconds) throw new TypeError('Invalid active bounds');
      intervals.push({ event_id: row.event_id, customer_id: row.customer_id, source: row.source,
        start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
    } catch { rejected += 1; }
  }
  return { intervals, rejectedRecords: rejected };
}
