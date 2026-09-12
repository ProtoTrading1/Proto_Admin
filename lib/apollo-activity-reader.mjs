import { activityEventRowsToIntervals, aggregateActiveIntervals } from './apollo-activity.mjs';
import { paginateSelect } from './apollo-reporting.mjs';

const SOURCES = ['main', 'instore'];
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_ROWS = 100_000;

function asTimestamp(value, label) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new TypeError(`${label} requires an explicit timezone`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid ${label}`);
  return parsed;
}

function iso(value) { return new Date(value).toISOString(); }

function sourceHealthRow(row, { startMs, endMs, checkedMs }) {
  if (!row || typeof row !== 'object' || !SOURCES.includes(row.source)) return null;
  try {
    const collectionStartedMs = asTimestamp(row.collection_started_at, 'collection_started_at');
    const lastSuccessfulMs = row.last_successful_at == null ? null : asTimestamp(row.last_successful_at, 'last_successful_at');
    const completeSinceMs = row.complete_since == null ? null : asTimestamp(row.complete_since, 'complete_since');
    const lastFailureMs = row.last_failure_at == null ? null : asTimestamp(row.last_failure_at, 'last_failure_at');
    if (collectionStartedMs > checkedMs || (lastSuccessfulMs !== null && lastSuccessfulMs > checkedMs) ||
      (completeSinceMs !== null && completeSinceMs < collectionStartedMs) ||
      (lastFailureMs !== null && lastFailureMs < collectionStartedMs)) return null;
    // complete_since is reset after a collector failure. A later failure makes
    // continuity unknown until the monitor supplies a newer complete_since.
    const verified = completeSinceMs !== null && completeSinceMs <= startMs &&
      lastSuccessfulMs !== null && lastSuccessfulMs >= endMs &&
      (lastFailureMs === null || lastFailureMs <= completeSinceMs);
    return {
      source: row.source,
      status: verified ? 'complete' : 'partial',
      verified,
      collectionStartedAt: iso(collectionStartedMs),
      completeSince: completeSinceMs === null ? null : iso(completeSinceMs),
      lastSuccessfulAt: lastSuccessfulMs === null ? null : iso(lastSuccessfulMs),
      lastFailureAt: lastFailureMs === null ? null : iso(lastFailureMs),
      freshnessSeconds: lastSuccessfulMs === null ? null : Math.max(0, Math.floor((checkedMs - lastSuccessfulMs) / 1000)),
    };
  } catch { return null; }
}

/**
 * Read the dedicated Apollo database through a service-role client only.
 * This function deliberately has no environment fallback: callers must pass
 * the isolated Apollo client after owner authorisation has already succeeded.
 */
export async function readApolloActivity({ client, window, checkedAt, pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_MAX_ROWS } = {}) {
  if (!client || typeof client.from !== 'function') throw new TypeError('Apollo activity client is required');
  const startMs = asTimestamp(window?.start, 'window start');
  const endMs = asTimestamp(window?.end, 'window end');
  const checkedMs = asTimestamp(checkedAt, 'checkedAt');
  if (endMs <= startMs || checkedMs < startMs) throw new TypeError('Invalid activity reporting window');

  const healthRows = await paginateSelect({
    pageSize: 10, maxRows: 10,
    selectPage: ({ from, to }) => client.from('apollo_collection_health')
      .select('source,collection_started_at,last_successful_at,complete_since,last_failure_at')
      .order('source', { ascending: true }).range(from, to),
  });
  const healthBySource = new Map();
  let invalidHealthRows = 0;
  for (const row of healthRows) {
    const parsed = sourceHealthRow(row, { startMs, endMs, checkedMs });
    if (!parsed || healthBySource.has(parsed.source)) { invalidHealthRows += 1; continue; }
    healthBySource.set(parsed.source, parsed);
  }
  const sources = Object.fromEntries(SOURCES.map((source) => {
    const state = healthBySource.get(source);
    return [source, state || { source, status: 'unavailable', verified: false, collectionStartedAt: null,
      completeSince: null, lastSuccessfulAt: null, lastFailureAt: null, freshnessSeconds: null }];
  }));

  // An interval can begin up to 60 seconds before the reporting window and
  // still contribute after clipping. Query that small overlap explicitly.
  const queryStart = iso(startMs - MAX_INTERVAL_MS);
  const eventRows = await paginateSelect({
    pageSize, maxRows,
    selectPage: ({ from, to }) => client.from('apollo_activity_events')
      .select('event_id,customer_id,source,event_type,occurred_at,received_at,payload')
      .gte('occurred_at', queryStart).lt('occurred_at', iso(endMs))
      .order('occurred_at', { ascending: true }).order('event_id', { ascending: true }).range(from, to),
  });
  const mapped = activityEventRowsToIntervals(eventRows);
  const aggregate = aggregateActiveIntervals(mapped.intervals, {
    start: iso(startMs), end: iso(endMs),
    coverage: Object.fromEntries(SOURCES.map((source) => [source, {
      verified: sources[source].verified, start: sources[source].completeSince, end: sources[source].lastSuccessfulAt,
    }])),
  });
  const complete = aggregate.complete && invalidHealthRows === 0 && mapped.rejectedRecords === 0;
  return {
    source: 'apollo_activity_events',
    status: 'available',
    complete,
    estimated: true,
    window: { start: iso(startMs), end: iso(endMs) },
    checkedAt: iso(checkedMs),
    sources,
    eventsRead: eventRows.length,
    invalidHealthRows,
    invalidEventRows: mapped.rejectedRecords,
    duplicateRecords: aggregate.duplicateRecords,
    activeSeconds: aggregate.activeSeconds,
    customers: aggregate.customers,
    limitations: complete ? [] : ['Activity time is estimated from visible, interacted intervals. A source is complete only when monitored coverage spans the full requested window.'],
  };
}
