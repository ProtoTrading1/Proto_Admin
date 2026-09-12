import { describe, expect, it } from 'vitest';
import { readApolloActivity } from '../lib/apollo-activity-reader.mjs';

const at = (seconds) => new Date(Date.UTC(2026, 8, 12, 12, 0, seconds)).toISOString();
function database(tables = {}) {
  const calls = [];
  return { calls, from(table) {
    calls.push(table);
    const filters = [];
    const q = { select() { return q; }, order() { return q; },
      gte(key, value) { filters.push((row) => row[key] >= value); return q; },
      lt(key, value) { filters.push((row) => row[key] < value); return q; },
      range(from, to) { return Promise.resolve({ data: (tables[table] || []).filter((row) => filters.every((f) => f(row))).slice(from, to + 1), error: null }); } };
    return q;
  } };
}
const window = { start: at(0), end: at(180) };
const completeHealth = (source) => ({ source, collection_started_at: at(-20), complete_since: at(-10), last_successful_at: at(180), last_failure_at: null });
const active = (id, source, start, end, customer = 'customer') => ({ event_id: id, customer_id: customer, source, event_type: 'active_interval', occurred_at: at(end), received_at: at(end), payload: { start_at: at(start), end_at: at(end), seconds: end - start } });

describe('Apollo activity reporting reader', () => {
  it('reports a fully monitored historical window and unions cross-surface activity', async () => {
    const result = await readApolloActivity({ client: database({ apollo_collection_health: [completeHealth('main'), completeHealth('instore')],
      apollo_activity_events: [active('a', 'main', 0, 60), active('b', 'instore', 30, 90)] }), window, checkedAt: at(180) });
    expect(result).toMatchObject({ status: 'available', complete: true, activeSeconds: 90, invalidHealthRows: 0, invalidEventRows: 0 });
    expect(result.sources.main).toMatchObject({ status: 'complete', verified: true, freshnessSeconds: 0 });
    expect(result.customers).toEqual([expect.objectContaining({ customerId: 'customer', mainSeconds: 60, instoreSeconds: 60, activeSeconds: 90 })]);
  });

  it('does not treat a missing health record or empty events as zero activity', async () => {
    const result = await readApolloActivity({ client: database({ apollo_collection_health: [completeHealth('main')] }), window, checkedAt: at(180) });
    expect(result.complete).toBe(false);
    expect(result.activeSeconds).toBe(null);
    expect(result.sources.instore).toMatchObject({ status: 'unavailable', verified: false, freshnessSeconds: null });
  });

  it('reports partial collection and freshness without claiming coverage', async () => {
    const stale = { ...completeHealth('main'), complete_since: at(10), last_successful_at: at(100), last_failure_at: at(110) };
    const result = await readApolloActivity({ client: database({ apollo_collection_health: [stale, completeHealth('instore')],
      apollo_activity_events: [active('a', 'main', 20, 50)] }), window, checkedAt: at(180) });
    expect(result.complete).toBe(false);
    expect(result.sources.main).toMatchObject({ status: 'partial', verified: false, freshnessSeconds: 80, lastFailureAt: at(110) });
    expect(result.activeSeconds).toBe(30);
  });

  it('includes the one-minute left overlap and refuses malformed health/events', async () => {
    const result = await readApolloActivity({ client: database({ apollo_collection_health: [completeHealth('main'), completeHealth('instore'), { source: 'main', collection_started_at: 'bad' }],
      apollo_activity_events: [active('overlap', 'main', -30, 30), { ...active('bad', 'main', 0, 30), payload: { start_at: at(0), end_at: at(30), seconds: 29 } }] }), window, checkedAt: at(180) });
    expect(result.invalidHealthRows).toBe(1);
    expect(result.invalidEventRows).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.activeSeconds).toBe(30);
  });

  it('has no client fallback and rejects invalid windows before database access', async () => {
    await expect(readApolloActivity({ client: database(), window: { start: '2026-09-12', end: at(10) }, checkedAt: at(10) })).rejects.toThrow('window start');
    await expect(readApolloActivity({ client: null, window, checkedAt: at(180) })).rejects.toThrow('client');
  });
});
