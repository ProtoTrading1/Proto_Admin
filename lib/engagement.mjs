/**
 * Engagement analytics — pure shaping.
 *
 * Three independent signals, deliberately kept separate because they start at
 * different dates and mean different things:
 *
 *   visits      customer_visits (migration 066) — one row per browsing
 *               session, so duration and per-day visitors are real.
 *   cart adds   customer_journey_events 'cart_item_added'.
 *   email       the campaign log, which predates both.
 *
 * Anything before those migrations shipped simply has no rows; the API says so
 * rather than drawing a flat line and letting it read as "nobody visited".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGES = {
  day: { days: 1, label: 'Today' },
  week: { days: 7, label: 'Last 7 days' },
  month: { days: 30, label: 'Last 30 days' },
};

export function rangeStart(range, now = Date.now()) {
  const spec = RANGES[range] || RANGES.week;
  return new Date(now - spec.days * DAY_MS);
}

function ms(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

/** Seconds a visit lasted, or null when it cannot be trusted. */
export function visitSeconds(visit) {
  const start = ms(visit?.started_at);
  const end = ms(visit?.last_seen_at);
  if (start === null || end === null || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * A single-beat visit lasts 0s — the customer arrived and we never heard from
 * them again. Those are real visits and count toward the visitor total, but
 * averaging them in would drag "time on site" toward zero and make the number
 * useless. The average is over visits that produced at least two beats.
 */
export const ENGAGED_VISIT_MIN_SECONDS = 30;

export function summariseVisits(visits = []) {
  const durations = [];
  const byCustomer = new Map();

  visits.forEach((visit) => {
    const seconds = visitSeconds(visit);
    if (seconds === null) return;
    durations.push(seconds);

    const id = String(visit.customer_id || '');
    const row = byCustomer.get(id) || { customerId: id, visits: 0, totalSeconds: 0, lastSeenAt: null };
    row.visits += 1;
    row.totalSeconds += seconds;
    if (!row.lastSeenAt || visit.last_seen_at > row.lastSeenAt) row.lastSeenAt = visit.last_seen_at;
    byCustomer.set(id, row);
  });

  const engaged = durations.filter((d) => d >= ENGAGED_VISIT_MIN_SECONDS);
  const avg = engaged.length
    ? Math.round(engaged.reduce((s, d) => s + d, 0) / engaged.length)
    : 0;

  return {
    visitors: byCustomer.size,
    visits: durations.length,
    bouncedVisits: durations.length - engaged.length,
    avgSecondsPerVisit: avg,
    totalSeconds: durations.reduce((s, d) => s + d, 0),
    byCustomer: [...byCustomer.values()],
  };
}

/** Buckets rows into YYYY-MM-DD counts so the panel can draw a trend. */
export function dailyCounts(rows = [], field = 'created_at') {
  const buckets = new Map();
  rows.forEach((row) => {
    const t = ms(row?.[field]);
    if (t === null) return;
    const key = new Date(t).toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
}

/** Distinct customers per day — "how many people", not "how many events". */
export function dailyUniqueCustomers(rows = [], field = 'created_at', idField = 'customer_id') {
  const buckets = new Map();
  rows.forEach((row) => {
    const t = ms(row?.[field]);
    const id = row?.[idField];
    if (t === null || !id) return;
    const key = new Date(t).toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key).add(String(id));
  });
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, set]) => ({ date, count: set.size }));
}

export function summariseCartAdds(events = []) {
  const customers = new Set();
  let units = 0;
  events.forEach((event) => {
    if (event?.customer_id) customers.add(String(event.customer_id));
    const qty = Number(event?.metadata?.qty);
    if (Number.isFinite(qty) && qty > 0) units += qty;
  });
  return { adds: events.length, customers: customers.size, units };
}

/** Campaign totals for the window, from the existing campaign log. */
export function summariseEmail(campaigns = [], since) {
  const cutoff = since instanceof Date ? since.getTime() : ms(since);
  const inRange = campaigns.filter((c) => {
    const t = ms(c?.sentAt);
    return t !== null && (cutoff === null || t >= cutoff);
  });

  const totals = inRange.reduce((acc, c) => {
    acc.campaigns += 1;
    acc.sent += Number(c.sent || 0);
    acc.opened += Number(c.opened || 0);
    acc.clicked += Number(c.clicked || 0);
    acc.bounced += Number(c.bounced || 0);
    return acc;
  }, { campaigns: 0, sent: 0, opened: 0, clicked: 0, bounced: 0 });

  return {
    ...totals,
    openRate: totals.sent ? totals.opened / totals.sent : 0,
    clickRate: totals.sent ? totals.clicked / totals.sent : 0,
    recent: inRange
      .slice()
      .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))
      .slice(0, 8)
      .map((c) => ({
        subject: c.subject || 'Campaign',
        sentAt: c.sentAt || null,
        sent: Number(c.sent || 0),
        opened: Number(c.opened || 0),
        clicked: Number(c.clicked || 0),
        bounced: Number(c.bounced || 0),
      })),
  };
}

/** Joins visit rows onto customer records for the browsed-customers list. */
export function buildVisitorRows(visitSummary, customers = []) {
  const byId = new Map();
  customers.forEach((c) => { if (c?.id) byId.set(String(c.id), c); });

  return visitSummary.byCustomer
    .map((row) => {
      const customer = byId.get(row.customerId);
      return {
        customerId: row.customerId,
        name: customer?.name || customer?.contact_name || customer?.first_name
          || customer?.business_name || customer?.email || 'Unknown customer',
        email: customer?.email || '',
        businessName: customer?.business_name || '',
        customerCode: customer?.customer_code || '',
        visits: row.visits,
        totalSeconds: row.totalSeconds,
        avgSeconds: row.visits ? Math.round(row.totalSeconds / row.visits) : 0,
        lastSeenAt: row.lastSeenAt,
        missing: !customer,
      };
    })
    .sort((a, b) => b.totalSeconds - a.totalSeconds || b.visits - a.visits);
}

/** "4m 20s" — engagement durations are minutes, not hours. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  if (mins < 60) return rest ? `${mins}m ${rest}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
