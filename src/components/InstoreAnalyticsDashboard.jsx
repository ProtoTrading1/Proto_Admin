import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const PERIODS = [7, 30, 90];
const count = (value) => Number(value || 0).toLocaleString('en-ZA');
const dateTime = (value) => value
  ? new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
  : 'Unknown';
const shortDate = (value) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-ZA', {
  day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg',
});

function trendRows(days, period) {
  if (period !== 90) return days;
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) {
    const group = days.slice(index, index + 7);
    weeks.push({
      date: group[0].date,
      endDate: group.at(-1).date,
      productOpens: group.reduce((sum, day) => sum + day.productOpens, 0),
    });
  }
  return weeks;
}

export default function InstoreAnalyticsDashboard() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('opens');
  const [showAll, setShowAll] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setData(null);
    setError('');
    try {
      const response = await fetch(`/api/instore-analytics?period=${period}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Instore analytics could not be loaded.');
      if (current === requestId.current) setData(body);
    } catch (cause) {
      if (current === requestId.current) setError(cause.message);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]);
  useEffect(() => {
    const refresh = (event) => { if (event.detail === 'analytics') void load(); };
    window.addEventListener(ADMIN_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, refresh);
  }, [load]);

  const rows = useMemo(() => {
    const products = [...(data?.products || [])];
    products.sort((a, b) => sort === 'units'
      ? b.unitsOrdered - a.unitsOrdered || b.views - a.views || a.sku.localeCompare(b.sku)
      : b.views - a.views || b.unitsOrdered - a.unitsOrdered || a.sku.localeCompare(b.sku));
    return showAll ? products : products.slice(0, 20);
  }, [data, showAll, sort]);
  const trend = useMemo(() => trendRows(data?.days || [], period), [data, period]);
  const maxOpens = Math.max(1, ...trend.map((day) => day.productOpens));

  return <div className="oa-dashboard ia-dashboard">
    <div className="ia-heading"><h2>Instore performance</h2><p>See what shoppers open and what appears in orders.</p></div>
    <div className="oa-toolbar">
      <div className="oa-periods" role="group" aria-label="Instore analytics period">
        {PERIODS.map((days) => <button key={days} type="button" className={`oa-period-btn${period === days ? ' oa-period-btn--active' : ''}`} onClick={() => { setShowAll(false); setPeriod(days); }} aria-pressed={period === days}>{days} days</button>)}
      </div>
      <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 size={15} className="star-spinning" /> : <RefreshCw size={15} />} Refresh</button>
    </div>
    <div className="ia-status" role="status"><AlertTriangle size={18} aria-hidden="true" /><span><strong>Page visits are temporarily unavailable.</strong> Existing category events may include automatic repeats, so they are excluded rather than presented as real visits.</span></div>
    {error && <div className="oa-error" role="alert">{error} Please try Refresh.</div>}
    {loading && <div className="oa-loading" role="status" aria-live="polite"><Loader2 size={24} className="star-spinning" /> Loading {period}-day Instore results…</div>}
    {data && <>
      <p className="ia-meta">Last {data.period} days · {dateTime(data.since)} to {dateTime(data.asOf)} SAST · updated {dateTime(data.asOf)}</p>
      <div className="oa-stat-grid ia-stat-grid">
        <div className="oa-stat-card oa-stat-card--accent"><div className="oa-stat-val">{count(data.productViews)}</div><div className="oa-stat-label">Product-open events</div><p>Repeat opens count separately.</p></div>
        <div className="oa-stat-card"><div className="oa-stat-val">{count(data.ordersWithInstore)}</div><div className="oa-stat-label">Orders with Instore items</div><p>Not attributed to a visit.</p></div>
        <div className="oa-stat-card"><div className="oa-stat-val">{count(data.unitsOrdered)}</div><div className="oa-stat-label">Instore units ordered</div><p>For currently listed codes.</p></div>
      </div>
      <section className="oa-panel ia-trend">
        <div className="oa-panel-head"><h3>Product opens over time</h3><span className="ia-section-note">{period === 90 ? '7-day groups' : 'Daily'} · South Africa time</span></div>
        {trend.some((day) => day.productOpens > 0) ? <div className="ia-chart-scroll"><div className="ia-bars" role="list" aria-label="Instore product opens over time">
          {trend.map((day) => {
            const label = day.endDate ? `${shortDate(day.date)}–${shortDate(day.endDate)}` : shortDate(day.date);
            return <div key={day.date} className="ia-bar-slot" role="listitem" tabIndex="0" aria-label={`${label}: ${count(day.productOpens)} product opens`} title={`${label}: ${count(day.productOpens)} product opens`}>
              <span className="ia-bar-count" aria-hidden="true">{day.productOpens || ''}</span>
              <span className="ia-bar" aria-hidden="true" style={{ height: `${Math.max(day.productOpens ? 8 : 2, day.productOpens / maxOpens * 100)}%` }} />
              <span className="ia-bar-label" aria-hidden="true">{period === 7 || period === 90 ? shortDate(day.date) : day.date.slice(-2)}</span>
            </div>;
          })}
        </div></div> : <p className="oa-empty">No recorded Instore product opens in this period.</p>}
      </section>
      <section className="oa-panel">
        <div className="oa-panel-head"><div><h3>Products customers opened or ordered</h3><p className="ia-section-note">Exact Instore code matches; opens and orders are separate measures.</p></div>
          <label className="ia-sort">Sort by <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="opens">Most opened</option><option value="units">Most units ordered</option></select></label>
        </div>
        {rows.length ? <><div className="oa-table-wrap"><table className="oa-table"><thead><tr><th scope="col">Code</th><th scope="col">Product</th><th scope="col">Opens</th><th scope="col">Units ordered</th></tr></thead><tbody>
          {rows.map((item) => <tr key={item.sku}><td className="ia-code">{item.sku}</td><td>{item.title}</td><td>{count(item.views)}</td><td>{count(item.unitsOrdered)}</td></tr>)}
        </tbody></table></div>{!showAll && data.products.length > 20 && <button type="button" className="ia-show-all" onClick={() => setShowAll(true)}>Show all {count(data.products.length)} products</button>}</>
          : <p className="oa-empty">No Instore product opens or orders were recorded in this period.</p>}
      </section>
      <details className="ia-method"><summary>How these numbers are measured</summary>
        <p>Product opens are recorded events, not unique shoppers. Orders contain at least one currently listed Instore code; cancelled, refunded and rejected orders are excluded. Units are the matched quantities. Orders are not attributed to a specific visit or product open.</p>
        <p>Historical membership is not stored: an item added to or removed from Instore can change older results. Product-level cart additions and unique Instore visits are not currently measurable. No conversion rate is shown.</p>
      </details>
    </>}
  </div>;
}
