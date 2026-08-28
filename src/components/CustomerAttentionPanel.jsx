import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Eye, Loader2, RefreshCw, Users } from 'lucide-react';
import { formatDuration } from '../../lib/engagement.mjs';

const RANGES = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
  { key: 'quarter', label: '90 days' },
];

function when(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function AttentionTable({ title, rows }) {
  return (
    <section className="oa-panel">
      <div className="oa-panel-head"><h3><Eye size={15} /> {title}</h3></div>
      {!rows.length ? <p className="oa-empty">Nothing recorded in this period.</p> : (
        <div className="oa-table-wrap">
          <table className="oa-table">
            <thead><tr><th>Name</th><th>Customers</th><th>Views</th><th>Total active time</th><th>Average view</th></tr></thead>
            <tbody>{rows.slice(0, 20).map((row) => (
              <tr key={row.id}><td>{row.label}</td><td>{row.customers}</td><td>{row.views}</td><td>{formatDuration(row.activeSeconds)}</td><td>{formatDuration(row.averageSeconds)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function CustomerAttentionPanel() {
  const [range, setRange] = useState('month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/customer-attention?range=${range}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Customer attention could not be loaded');
      setData(json);
    } catch (loadError) {
      setError(loadError.message); setData(null);
    } finally { setLoading(false); }
  }, [range]);

  useEffect(() => { void load(); }, [load]);
  const customerRows = useMemo(() => (data?.customerRows || []).filter((row) => filter === 'all' || row.contentType === filter), [data, filter]);

  return (
    <div className="oa-dashboard">
      <div className="oa-toolbar"><div className="oa-periods">{RANGES.map((item) => (
        <button key={item.key} type="button" className={`oa-period-btn${range === item.key ? ' oa-period-btn--active' : ''}`} onClick={() => setRange(item.key)}>{item.label}</button>
      ))}</div><button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Refresh</button></div>
      {error && <div className="oa-error">{error}</div>}
      {data && !data.available && <div className="oa-error">Attention recording is not live yet. This preview is safe, but no duration history exists until the storefront tracking release is enabled.</div>}
      {data?.available && <>
        <div className="oa-stat-grid ab-stat-grid">
          <div className="oa-stat-card oa-stat-card--accent"><div className="oa-stat-val">{data.customers}</div><div className="oa-stat-label"><Users size={14} /> Customers measured</div></div>
          <div className="oa-stat-card"><div className="oa-stat-val">{data.productsViewed}</div><div className="oa-stat-label">Products viewed</div></div>
          <div className="oa-stat-card"><div className="oa-stat-val">{data.categoriesViewed}</div><div className="oa-stat-label">Categories viewed</div></div>
          <div className="oa-stat-card"><div className="oa-stat-val">{formatDuration(data.totalActiveSeconds)}</div><div className="oa-stat-label"><Clock3 size={14} /> Active attention</div></div>
        </div>
        <div className="oa-split"><AttentionTable title="Products holding attention" rows={data.products || []} /><AttentionTable title="Categories holding attention" rows={data.categories || []} /></div>
        <section className="oa-panel">
          <div className="oa-panel-head"><div><h3><Users size={15} /> What each customer viewed</h3><p className="oa-note">Active time counts only while the page is visible, focused and recently used.</p></div><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Products and categories</option><option value="product">Products only</option><option value="category">Categories only</option></select></div>
          <div className="oa-table-wrap"><table className="oa-table"><thead><tr><th>Customer</th><th>Viewed</th><th>Type</th><th>Views</th><th>Active time</th><th>Last viewed</th></tr></thead><tbody>{customerRows.slice(0, 100).map((row) => (
            <tr key={`${row.customerId}-${row.contentType}-${row.entityId}`}><td><strong>{row.customerName}</strong>{row.companyName && <span className="ab-business">{row.companyName}</span>}</td><td>{row.entityLabel}</td><td>{row.contentType === 'product' ? 'Product' : 'Category'}</td><td>{row.views}</td><td>{formatDuration(row.activeSeconds)}</td><td>{when(row.lastSeenAt)}</td></tr>
          ))}</tbody></table></div>
        </section>
      </>}
    </div>
  );
}
