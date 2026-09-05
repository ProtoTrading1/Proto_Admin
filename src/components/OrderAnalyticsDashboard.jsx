import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { downloadCsv, downloadExcel } from '../lib/exportReport';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const PERIODS = [7, 30, 90, 120];

function money(n) {
  return `R ${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function PanelHeader({ title, onExport, exportLabel = 'Export Report' }) {
  return (
    <div className="oa-panel-head">
      <h3>{title}</h3>
      {onExport && (
        <button type="button" className="oa-export-btn" onClick={onExport}>
          <Download size={14} />
          {exportLabel}
        </button>
      )}
    </div>
  );
}

function HorizontalBars({ rows, valueKey = 'qty', labelKey = 'name', fallbackLabelKey, max = 10 }) {
  const data = (rows || []).slice(0, max);
  const peak = Math.max(1, ...data.map((r) => Number(r[valueKey] || r.views || 0)));
  if (!data.length) return <p className="oa-empty">No data for this period.</p>;
  return (
    <div className="oa-hbars">
      {data.map((row, i) => {
        const val = Number(row[valueKey] ?? row.views ?? row.qty ?? 0);
        const label = row[labelKey] || row[fallbackLabelKey] || row.label || row.code || '—';
        return (
          <div key={`${label}-${i}`} className="oa-hbar-row">
            <span className="oa-hbar-label" title={label}>{label}</span>
            <div className="oa-hbar-track">
              <div className="oa-hbar-fill" style={{ width: `${(val / peak) * 100}%` }} />
            </div>
            <span className="oa-hbar-val">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

function DonutChart({ slices }) {
  const data = (slices || []).filter((s) => s.count > 0);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return <p className="oa-empty">No data for this period.</p>;

  const colors = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#dc2626', '#64748b'];
  let offset = 0;
  const segments = data.map((slice, i) => {
    const pct = slice.count / total;
    const dash = `${pct * 100} ${100 - pct * 100}`;
    const seg = { ...slice, dash, offset, color: colors[i % colors.length], pct };
    offset += pct * 100;
    return seg;
  });

  return (
    <div className="oa-donut-wrap">
      <svg viewBox="0 0 42 42" className="oa-donut">
        {segments.map((seg) => (
          <circle
            key={seg.label}
            cx="21"
            cy="21"
            r="15.915"
            fill="transparent"
            stroke={seg.color}
            strokeWidth="4"
            strokeDasharray={seg.dash}
            strokeDashoffset={25 - seg.offset}
          />
        ))}
      </svg>
      <ul className="oa-donut-legend">
        {segments.map((seg) => (
          <li key={seg.label}>
            <span className="oa-dot" style={{ background: seg.color }} />
            <span>{seg.label}</span>
            <strong>{seg.count}</strong>
            <span className="oa-muted">{Math.round(seg.pct * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimeBars({ rows, valueKey = 'orders' }) {
  if (!rows?.length) return <p className="oa-empty">No orders in this period.</p>;
  const peak = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <div className="oa-time-bars">
      {rows.map((row) => (
        <div key={row.label || row.date} className="oa-time-bar-col" title={`${row.label}: ${row[valueKey]}`}>
          <div className="oa-time-bar-fill" style={{ height: `${((row[valueKey] || 0) / peak) * 100}%` }} />
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function OrderAnalyticsDashboard() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [customerLimit, setCustomerLimit] = useState(5);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/order-analytics?period=${period}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load analytics');
      setData(json);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'analytics') void load();
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  const summary = data?.summary;
  const periodTag = `${period}d`;

  const topOrderedProducts = useMemo(
    () => (data?.topOrderedProducts || []).slice(0, 10),
    [data],
  );
  const topViewedProducts = useMemo(
    () => (data?.topViewedProducts || []).slice(0, 10),
    [data],
  );
  const visibleCustomers = useMemo(
    () => (data?.topCustomers || []).slice(0, customerLimit),
    [data, customerLimit],
  );

  const peakDay = useMemo(() => {
    if (!data?.peakByDay?.length) return null;
    return [...data.peakByDay].sort((a, b) => b.orders - a.orders)[0];
  }, [data]);

  const peakHour = useMemo(() => {
    if (!data?.peakByHour?.length) return null;
    return [...data.peakByHour].sort((a, b) => b.orders - a.orders)[0];
  }, [data]);

  const exportOrderedItems = () => {
    downloadCsv(`most-ordered-items-${periodTag}.csv`, [
      { header: 'Code', key: 'code' },
      { header: 'Product', key: 'name' },
      { header: 'Category', key: 'category' },
      { header: 'Qty Ordered', key: 'qty' },
    ], topOrderedProducts);
  };

  const exportViewedProducts = () => {
    downloadCsv(`most-viewed-products-${periodTag}.csv`, [
      { header: 'Product', key: 'label' },
      { header: 'Views', key: 'views' },
    ], topViewedProducts);
  };

  const exportCustomersExcel = () => {
    void downloadExcel(
      `top-customers-${periodTag}.xlsx`,
      'Top Customers',
      [
        { header: 'Customer', key: 'name' },
        { header: 'Email', key: 'email' },
        { header: 'Orders', key: 'orders' },
        { header: 'Spend (ZAR)', value: (r) => Number(r.spend || 0).toFixed(2) },
      ],
      visibleCustomers,
    );
  };

  return (
    <div className="oa-dashboard">
      <div className="oa-toolbar">
        <div className="oa-periods">
          {PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              className={`oa-period-btn${period === d ? ' oa-period-btn--active' : ''}`}
              onClick={() => setPeriod(d)}
            >
              {d} days
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={15} className="star-spinning" /> : <RefreshCw size={15} />}
            Refresh
          </button>
          <button
            type="button"
            className="adm-btn-ghost adm-btn-ghost--danger"
            onClick={() => setClearConfirmOpen(true)}
            disabled={loading || clearing}
          >
            <Trash2 size={15} />
            Clear analytics
          </button>
        </div>
      </div>

      {clearConfirmOpen && (
        <div className="adm-modal-backdrop" onClick={() => setClearConfirmOpen(false)}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Clear all analytics?</h3>
              <button type="button" className="adm-modal-close" onClick={() => setClearConfirmOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <p className="adm-modal-note">
              This permanently deletes all tracked product and category view events.
              Order history is not affected — order totals and revenue come from the
              orders themselves. This cannot be undone.
            </p>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={() => setClearConfirmOpen(false)}>Cancel</button>
                <button
                  type="button"
                  className="adm-btn-red"
                  disabled={clearing}
                  onClick={async () => {
                    setClearing(true);
                    try {
                      const [orderRes, searchRes] = await Promise.all([
                        fetch('/api/order-analytics', { method: 'DELETE' }),
                        fetch('/api/search-analytics-dashboard', { method: 'DELETE' }),
                      ]);
                      const orderJson = await orderRes.json().catch(() => ({}));
                      const searchJson = await searchRes.json().catch(() => ({}));
                      if (!orderRes.ok) throw new Error(orderJson.error || 'Failed to clear order analytics');
                      if (!searchRes.ok) throw new Error(searchJson.error || 'Failed to clear search analytics');
                      setClearConfirmOpen(false);
                      await load();
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setClearing(false);
                    }
                  }}
                >
                  {clearing ? 'Clearing…' : 'Clear analytics'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <div className="oa-error">{error}</div>}
      {loading && !data && (
        <div className="oa-loading"><Loader2 size={28} className="star-spinning" /></div>
      )}

      {summary && (
        <>
          <div className="oa-stat-grid">
            <div className="oa-stat-card"><div className="oa-stat-val">{summary.totalOrders}</div><div className="oa-stat-label">Total Orders</div></div>
            <div className="oa-stat-card oa-stat-card--accent"><div className="oa-stat-val">{money(summary.totalRevenue)}</div><div className="oa-stat-label">Total Revenue</div></div>
            <div className="oa-stat-card"><div className="oa-stat-val">{money(summary.avgOrderValue)}</div><div className="oa-stat-label">Average Order Value</div></div>
            <div className="oa-stat-card"><div className="oa-stat-val">{summary.customersWhoOrdered}</div><div className="oa-stat-label">Customers Who Ordered</div></div>
          </div>

          <section className="oa-panel">
            <PanelHeader title="Orders Over Time" />
            <TimeBars rows={data.ordersOverTime} valueKey="orders" />
          </section>

          <div className="oa-split">
            <section className="oa-panel">
              <PanelHeader title="Most Ordered Items (Top 10)" onExport={exportOrderedItems} />
              <HorizontalBars rows={topOrderedProducts} valueKey="qty" labelKey="name" fallbackLabelKey="code" max={10} />
            </section>
            <section className="oa-panel">
              <PanelHeader title="Most Ordered Categories" />
              <DonutChart slices={data.topOrderedCategories?.map((c) => ({ label: c.label, count: c.qty }))} />
            </section>
          </div>

          <div className="oa-split">
            <section className="oa-panel">
              <PanelHeader title="Most Viewed Products (Top 10)" onExport={exportViewedProducts} />
              {!data.trackingEnabled && <p className="oa-note">Product view tracking activates after the portal migration is applied.</p>}
              <HorizontalBars rows={topViewedProducts} valueKey="views" labelKey="label" max={10} />
            </section>
            <section className="oa-panel">
              <PanelHeader title="Most Viewed Categories" />
              {!data.trackingEnabled && <p className="oa-note">Category view tracking activates after the portal migration is applied.</p>}
              <DonutChart slices={data.topViewedCategories?.map((c) => ({ label: c.label, count: c.views }))} />
            </section>
          </div>

          <div className="oa-split">
            <section className="oa-panel">
              <PanelHeader title="Order Status Breakdown" />
              <DonutChart slices={data.orderStatusBreakdown} />
            </section>
            <section className="oa-panel">
              <PanelHeader title="Peak Order Times" />
              <div className="oa-peak-grid">
                <div>
                  <div className="oa-subhead">By day of week</div>
                  <HorizontalBars rows={data.peakByDay?.map((d) => ({ name: d.day, qty: d.orders }))} valueKey="qty" labelKey="name" max={7} />
                </div>
                <div>
                  <div className="oa-subhead">By hour</div>
                  <div className="oa-hour-bars">
                    {data.peakByHour?.map((h) => {
                      const peak = Math.max(1, ...data.peakByHour.map((x) => x.orders));
                      return (
                        <div key={h.hour} className="oa-hour-col" title={`${h.hour}:00 — ${h.orders} orders`}>
                          <div className="oa-hour-fill" style={{ height: `${(h.orders / peak) * 100}%` }} />
                        </div>
                      );
                    })}
                  </div>
                  <div className="oa-peak-hint">
                    {peakDay && peakHour ? (
                      <>Busiest: <strong>{peakDay.day}</strong> · peak hour <strong>{String(peakHour.hour).padStart(2, '0')}:00</strong></>
                    ) : '—'}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="oa-panel">
            <PanelHeader title="Additional Insights" />
            <div className="oa-insights-row">
              <div className="oa-insight-card">
                <div className="oa-insight-val">{summary.repeatCustomerPct}%</div>
                <div className="oa-insight-label">Repeat customers (of those who ordered)</div>
              </div>
              <div className="oa-insight-card">
                <div className="oa-insight-val">{100 - summary.repeatCustomerPct}%</div>
                <div className="oa-insight-label">First-time order share</div>
              </div>
            </div>
          </section>

          <section className="oa-panel">
            <div className="oa-panel-head">
              <h3>Top Customers</h3>
              <div className="oa-panel-actions">
                <label className="oa-select-wrap">
                  <span>Show</span>
                  <select value={customerLimit} onChange={(e) => setCustomerLimit(Number(e.target.value))}>
                    <option value={5}>Top 5</option>
                    <option value={50}>Top 50</option>
                  </select>
                </label>
                <button type="button" className="oa-export-btn" onClick={exportCustomersExcel} disabled={!visibleCustomers.length}>
                  <Download size={14} />
                  Export Excel
                </button>
              </div>
            </div>
            {!visibleCustomers.length ? (
              <p className="oa-empty">No customer orders in this period.</p>
            ) : (
              <div className="oa-table-wrap">
                <table className="oa-table">
                  <thead>
                    <tr><th>Customer</th><th>Email</th><th>Orders</th><th>Spend</th></tr>
                  </thead>
                  <tbody>
                    {visibleCustomers.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.email}</td>
                        <td>{c.orders}</td>
                        <td>{money(c.spend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
