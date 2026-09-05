/**
 * Engagement — browsing, basket activity and email, over a day, week or month.
 *
 * Each block reports its own availability. Browsing and cart data only start
 * from the storefront release that began capturing them, so an empty block
 * says "not recorded yet" rather than showing a confident zero.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock, Loader2, Mail, MousePointerClick, RefreshCw, ShoppingCart, Users,
} from 'lucide-react';
import { formatDuration } from '../../lib/engagement.mjs';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const RANGES = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

const VISITOR_PAGE_SIZES = [10, 25, 50, 0];

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function whenLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function dayLabel(iso) {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

/** Small bar strip — same visual language as the order analytics trends. */
function TrendBars({ rows, label }) {
  if (!rows?.length) return <p className="oa-empty">Nothing recorded in this period.</p>;
  const peak = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="oa-time-bars">
      {rows.map((row) => (
        <div key={row.date} className="oa-time-bar-col" title={`${row.count} ${label} on ${dayLabel(row.date)}`}>
          <div className="oa-time-bar-fill" style={{ height: `${(row.count / peak) * 100}%` }} />
          <span>{dayLabel(row.date)}</span>
        </div>
      ))}
    </div>
  );
}

function NotRecorded({ what }) {
  return (
    <p className="oa-empty">
      {what} is not being recorded yet — it starts once the storefront release that
      captures it is live. Nothing is missing from the database; there is simply
      no history before that point.
    </p>
  );
}

export default function EngagementPanel() {
  const [range, setRange] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [visitorLimit, setVisitorLimit] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/engagement?range=${range}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load engagement');
      setData(json);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = (event) => { if (event.detail === 'analytics') void load(); };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  const browsing = data?.browsing;
  const cart = data?.cart;
  const email = data?.email;

  const visitors = useMemo(() => {
    const rows = browsing?.visitors || [];
    return visitorLimit > 0 ? rows.slice(0, visitorLimit) : rows;
  }, [browsing, visitorLimit]);

  return (
    <div className="oa-dashboard">
      <div className="oa-toolbar">
        <div className="oa-periods">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`oa-period-btn${range === r.key ? ' oa-period-btn--active' : ''}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={15} className="star-spinning" /> : <RefreshCw size={15} />}
          Refresh
        </button>
      </div>

      {error && <div className="oa-error">{error}</div>}
      {loading && !data && <div className="oa-loading"><Loader2 size={28} className="star-spinning" /></div>}

      {data && (
        <>
          <div className="oa-stat-grid ab-stat-grid">
            <div className="oa-stat-card oa-stat-card--accent">
              <div className="oa-stat-val">{browsing?.available ? browsing.visitors.length : '—'}</div>
              <div className="oa-stat-label">Customers Who Browsed</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{browsing?.available ? browsing.visits : '—'}</div>
              <div className="oa-stat-label">Browsing Sessions</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">
                {browsing?.available ? formatDuration(browsing.avgSecondsPerVisit) : '—'}
              </div>
              <div className="oa-stat-label">Average Time On Site</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{cart?.available ? cart.customers : '—'}</div>
              <div className="oa-stat-label">Customers Who Added To Cart</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{cart?.available ? cart.adds : '—'}</div>
              <div className="oa-stat-label">Items Added</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{email?.sent ?? 0}</div>
              <div className="oa-stat-label">Emails Sent</div>
            </div>
          </div>

          <div className="oa-split">
            <section className="oa-panel">
              <div className="oa-panel-head"><h3><Users size={15} /> Customers browsing per day</h3></div>
              {browsing?.available
                ? <TrendBars rows={browsing.daily} label="customers" />
                : <NotRecorded what="Browsing" />}
            </section>

            <section className="oa-panel">
              <div className="oa-panel-head"><h3><ShoppingCart size={15} /> Customers adding to cart per day</h3></div>
              {cart?.available
                ? <TrendBars rows={cart.daily} label="customers" />
                : <NotRecorded what="Basket activity" />}
            </section>
          </div>

          <section className="oa-panel">
            <div className="oa-panel-head">
              <div>
                <h3><Clock size={15} /> Who browsed the site</h3>
                <p className="oa-note">
                  Ranked by total time on site.
                  {browsing?.available && browsing.bouncedVisits > 0 && (
                    <> {browsing.bouncedVisits} single-moment {browsing.bouncedVisits === 1 ? 'visit is' : 'visits are'} counted
                      as visitors but left out of the average, so one glance does not drag it to zero.</>
                  )}
                </p>
              </div>
              <span className="oa-select-wrap">
                Show
                <select value={visitorLimit} onChange={(e) => setVisitorLimit(Number(e.target.value))}>
                  {VISITOR_PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>{size === 0 ? 'Show all' : `${size} customers`}</option>
                  ))}
                </select>
              </span>
            </div>

            {!browsing?.available && <NotRecorded what="Browsing" />}

            {browsing?.available && !visitors.length && (
              <p className="oa-empty">No signed-in customers browsed in this period.</p>
            )}

            {visitors.length > 0 && (
              <div className="oa-table-wrap">
                <table className="oa-table ab-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Contact</th>
                      <th className="ab-num">Visits</th>
                      <th className="ab-num">Total time</th>
                      <th className="ab-num">Avg / visit</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitors.map((v) => (
                      <tr key={v.customerId}>
                        <td>
                          <span className="ab-name">{v.name}</span>
                          {v.businessName && <span className="ab-business">{v.businessName}</span>}
                          {v.missing && <span className="ab-badge ab-badge--warn">No customer record</span>}
                        </td>
                        <td className="ab-contact">{v.email || '—'}</td>
                        <td className="ab-num">{v.visits}</td>
                        <td className="ab-num ab-strong">{formatDuration(v.totalSeconds)}</td>
                        <td className="ab-num">{formatDuration(v.avgSeconds)}</td>
                        <td className="ab-contact">{whenLabel(v.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {browsing?.available && browsing.visitors.length > visitors.length && (
              <p className="oa-note ab-more-note">
                Showing {visitors.length} of {browsing.visitors.length}.{' '}
                <button type="button" className="ab-linkish" onClick={() => setVisitorLimit(0)}>Show all</button>
              </p>
            )}
          </section>

          <section className="oa-panel">
            <div className="oa-panel-head">
              <h3><Mail size={15} /> Email engagement</h3>
              <span className="oa-note">
                {email?.campaigns || 0} campaign{email?.campaigns === 1 ? '' : 's'} in this period
              </span>
            </div>

            <div className="oa-insights-row eng-email-row">
              <div className="oa-insight-card">
                <div className="oa-insight-val">{email?.sent ?? 0}</div>
                <div className="oa-insight-label">Sent</div>
              </div>
              <div className="oa-insight-card">
                <div className="oa-insight-val">{pct(email?.openRate)}</div>
                <div className="oa-insight-label">{email?.opened ?? 0} opened</div>
              </div>
              <div className="oa-insight-card">
                <div className="oa-insight-val">{pct(email?.clickRate)}</div>
                <div className="oa-insight-label">
                  <MousePointerClick size={12} /> {email?.clicked ?? 0} clicked
                </div>
              </div>
              <div className="oa-insight-card">
                <div className="oa-insight-val">{email?.bounced ?? 0}</div>
                <div className="oa-insight-label">Bounced</div>
              </div>
            </div>

            {email?.recent?.length > 0 && (
              <div className="oa-table-wrap" style={{ marginTop: 14 }}>
                <table className="oa-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Sent</th>
                      <th className="ab-num">Recipients</th>
                      <th className="ab-num">Opened</th>
                      <th className="ab-num">Clicked</th>
                      <th className="ab-num">Bounced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {email.recent.map((c) => (
                      <tr key={`${c.subject}-${c.sentAt}`}>
                        <td>{c.subject}</td>
                        <td className="ab-contact">{whenLabel(c.sentAt)}</td>
                        <td className="ab-num">{c.sent}</td>
                        <td className="ab-num">{c.opened}</td>
                        <td className="ab-num">{c.clicked}</td>
                        <td className="ab-num">{c.bounced}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!email?.recent?.length && <p className="oa-empty">No campaigns sent in this period.</p>}
          </section>
        </>
      )}
    </div>
  );
}
