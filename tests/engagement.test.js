import { describe, expect, it } from 'vitest';
import {
  ENGAGED_VISIT_MIN_SECONDS,
  buildVisitorRows,
  dailyCounts,
  dailyUniqueCustomers,
  formatDuration,
  rangeStart,
  summariseCartAdds,
  summariseEmail,
  summariseVisits,
  visitSeconds,
} from '../lib/engagement.mjs';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const at = (iso) => new Date(iso).toISOString();

const visit = (over = {}) => ({
  customer_id: 'cust-1',
  session_id: 'sess-1',
  started_at: at('2026-08-13T10:00:00Z'),
  last_seen_at: at('2026-08-13T10:05:00Z'),
  ...over,
});

describe('visitSeconds', () => {
  it('measures the gap between the first and last beat', () => {
    expect(visitSeconds(visit())).toBe(300);
  });

  it('refuses to invent a duration from unusable timestamps', () => {
    expect(visitSeconds({ started_at: 'nope', last_seen_at: at('2026-08-13T10:05:00Z') })).toBeNull();
    expect(visitSeconds({ started_at: at('2026-08-13T10:05:00Z') })).toBeNull();
    expect(visitSeconds({})).toBeNull();
  });

  it('rejects a negative span rather than reporting a negative visit', () => {
    expect(visitSeconds(visit({ last_seen_at: at('2026-08-13T09:00:00Z') }))).toBeNull();
  });
});

describe('summariseVisits', () => {
  it('counts distinct customers, not sessions', () => {
    const summary = summariseVisits([
      visit(),
      visit({ session_id: 'sess-2' }),
      visit({ customer_id: 'cust-2', session_id: 'sess-3' }),
    ]);
    expect(summary.visitors).toBe(2);
    expect(summary.visits).toBe(3);
  });

  it('leaves single-moment visits out of the average but still counts them', () => {
    // A 0s visit is real — someone arrived and never beat again. Averaging it
    // in would drag "time on site" toward zero and make the number useless.
    const summary = summariseVisits([
      visit({ last_seen_at: at('2026-08-13T10:00:00Z') }),
      visit({ session_id: 'sess-2', last_seen_at: at('2026-08-13T10:10:00Z') }),
    ]);
    expect(summary.visits).toBe(2);
    expect(summary.bouncedVisits).toBe(1);
    expect(summary.avgSecondsPerVisit).toBe(600);
  });

  it('reports a zero average rather than NaN when every visit bounced', () => {
    const summary = summariseVisits([visit({ last_seen_at: at('2026-08-13T10:00:00Z') })]);
    expect(summary.avgSecondsPerVisit).toBe(0);
  });

  it('uses a threshold, not merely non-zero, to decide what counts as engaged', () => {
    const brief = summariseVisits([
      visit({ last_seen_at: at('2026-08-13T10:00:05Z') }), // 5s
    ]);
    expect(ENGAGED_VISIT_MIN_SECONDS).toBeGreaterThan(5);
    expect(brief.bouncedVisits).toBe(1);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(summariseVisits([])).toMatchObject({ visitors: 0, visits: 0, avgSecondsPerVisit: 0 });
  });
});

describe('daily buckets', () => {
  const rows = [
    { customer_id: 'a', created_at: at('2026-08-11T08:00:00Z') },
    { customer_id: 'a', created_at: at('2026-08-11T09:00:00Z') },
    { customer_id: 'b', created_at: at('2026-08-11T10:00:00Z') },
    { customer_id: 'a', created_at: at('2026-08-12T10:00:00Z') },
  ];

  it('counts events per day', () => {
    expect(dailyCounts(rows)).toEqual([
      { date: '2026-08-11', count: 3 },
      { date: '2026-08-12', count: 1 },
    ]);
  });

  it('counts people per day, not events', () => {
    expect(dailyUniqueCustomers(rows)).toEqual([
      { date: '2026-08-11', count: 2 },
      { date: '2026-08-12', count: 1 },
    ]);
  });

  it('drops rows with no usable date instead of bucketing them under today', () => {
    expect(dailyCounts([{ created_at: 'rubbish' }, { }])).toEqual([]);
  });
});

describe('summariseCartAdds', () => {
  it('separates adds, people and units', () => {
    expect(summariseCartAdds([
      { customer_id: 'a', metadata: { qty: 2 } },
      { customer_id: 'a', metadata: { qty: 3 } },
      { customer_id: 'b', metadata: {} },
    ])).toEqual({ adds: 3, customers: 2, units: 5 });
  });

  it('ignores a nonsense quantity rather than poisoning the unit total', () => {
    expect(summariseCartAdds([{ customer_id: 'a', metadata: { qty: -4 } }]).units).toBe(0);
    expect(summariseCartAdds([{ customer_id: 'a', metadata: { qty: 'lots' } }]).units).toBe(0);
  });
});

describe('summariseEmail', () => {
  const campaigns = [
    { subject: 'Old', sentAt: at('2026-07-01T10:00:00Z'), sent: 100, opened: 10, clicked: 1 },
    { subject: 'Recent', sentAt: at('2026-08-12T10:00:00Z'), sent: 200, opened: 100, clicked: 20, bounced: 2 },
  ];

  it('only counts campaigns inside the window', () => {
    const summary = summariseEmail(campaigns, new Date(Date.UTC(2026, 7, 1)));
    expect(summary.campaigns).toBe(1);
    expect(summary.sent).toBe(200);
  });

  it('derives open and click rates from what was actually sent', () => {
    const summary = summariseEmail(campaigns, new Date(Date.UTC(2026, 7, 1)));
    expect(summary.openRate).toBeCloseTo(0.5, 5);
    expect(summary.clickRate).toBeCloseTo(0.1, 5);
  });

  it('does not divide by zero when nothing was sent', () => {
    expect(summariseEmail([], new Date(NOW))).toMatchObject({ sent: 0, openRate: 0, clickRate: 0 });
  });

  it('lists the most recent campaigns first', () => {
    const summary = summariseEmail(campaigns, null);
    expect(summary.recent[0].subject).toBe('Recent');
  });
});

describe('buildVisitorRows', () => {
  it('joins customer detail and ranks by total time', () => {
    const summary = summariseVisits([
      visit({ customer_id: 'a', last_seen_at: at('2026-08-13T10:02:00Z') }),
      visit({ customer_id: 'b', session_id: 's2', last_seen_at: at('2026-08-13T10:20:00Z') }),
    ]);
    const rows = buildVisitorRows(summary, [
      { id: 'a', name: 'Ann', email: 'ann@example.com' },
      { id: 'b', business_name: 'Bee Trading', email: 'b@example.com' },
    ]);
    expect(rows.map((r) => r.customerId)).toEqual(['b', 'a']);
    expect(rows[1].name).toBe('Ann');
    // Falls back to business name when there is no personal name.
    expect(rows[0].name).toBe('Bee Trading');
  });

  it('keeps a visitor with no customer record and flags it', () => {
    const summary = summariseVisits([visit({ customer_id: 'ghost' })]);
    const [row] = buildVisitorRows(summary, []);
    expect(row.missing).toBe(true);
    expect(row.name).toBe('Unknown customer');
  });
});

describe('formatDuration', () => {
  it('reads as minutes and seconds, which is the scale of a visit', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(260)).toBe('4m 20s');
    expect(formatDuration(3720)).toBe('1h 2m');
  });

  it('never shows a negative or NaN duration', () => {
    expect(formatDuration(-10)).toBe('0s');
    expect(formatDuration('nonsense')).toBe('0s');
  });
});

describe('rangeStart', () => {
  it('covers a day, a week and a month back from now', () => {
    expect(NOW - rangeStart('day', NOW).getTime()).toBe(24 * 3600 * 1000);
    expect(NOW - rangeStart('week', NOW).getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(NOW - rangeStart('month', NOW).getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it('falls back to a week for an unknown range', () => {
    expect(rangeStart('century', NOW).getTime()).toBe(rangeStart('week', NOW).getTime());
  });
});
