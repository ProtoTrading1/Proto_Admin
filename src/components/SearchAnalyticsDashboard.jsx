import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { downloadCsv } from '../lib/exportReport';
import { PROTO_URLS } from '../lib/protoUrls';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const PERIODS = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 0, label: 'All time' },
];

function money(n) {
  return `R ${Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function todayTag() {
  return new Date().toISOString().slice(0, 10);
}

function PanelHeader({ title, onExport }) {
  return (
    <div className="oa-panel-head">
      <h3>{title}</h3>
      {onExport && (
        <button type="button" className="oa-export-btn" onClick={onExport}>
          <Download size={14} />
          Export CSV
        </button>
      )}
    </div>
  );
}

function TimeBars({ rows, valueKey = 'searches' }) {
  if (!rows?.length) return <p className="oa-empty">No data yet.</p>;
  const peak = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <div className="oa-time-bars">
      {rows.map((row) => (
        <div key={row.date || row.label} className="oa-time-bar-col" title={`${row.label}: ${row[valueKey]}`}>
          <div className="oa-time-bar-fill" style={{ height: `${((row[valueKey] || 0) / peak) * 100}%` }} />
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

function FunnelBars({ funnel }) {
  if (!funnel?.total) return <p className="oa-empty">No searches in this period.</p>;
  const stages = [
    { label: 'Searches', value: funnel.total },
    { label: 'Clicks', value: funnel.clicks },
    { label: 'Added to cart', value: funnel.cart },
    { label: 'Orders', value: funnel.orders },
  ];
  const peak = Math.max(1, funnel.total);
  let prev = funnel.total;
  return (
    <div className="oa-hbars sa-funnel">
      {stages.map((stage, idx) => {
        const drop = idx > 0 && prev > 0 ? Math.round((1 - stage.value / prev) * 100) : 0;
        const dropLabel = idx === 0 ? '' : ` (−${drop}%)`;
        if (idx > 0) prev = stage.value;
        return (
          <div key={stage.label} className="oa-hbar-row">
            <span className="oa-hbar-label">{stage.label}</span>
            <div className="oa-hbar-track">
              <div className="oa-hbar-fill" style={{ width: `${(stage.value / peak) * 100}%` }} />
            </div>
            <span className="oa-hbar-val">{stage.value}{dropLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

function DataTable({ columns, rows, emptyLabel = 'No data yet.' }) {
  if (!rows?.length) return <p className="oa-empty">{emptyLabel}</p>;
  return (
    <div className="oa-table-wrap">
      <table className="oa-table">
        <thead>
          <tr>
            {columns.map((col) => <th key={col.key || col.header}>{col.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || `${i}-${row.normalized_search_term || row.search_term}`}>
              {columns.map((col) => (
                <td key={col.key || col.header}>
                  {col.render ? col.render(row) : (row[col.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SearchAnalyticsDashboard() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/search-analytics-dashboard?period=${period}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load search analytics');
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

  const kpis = data?.kpis;
  const dateTag = todayTag();

  return (
    <div className="oa-dashboard sa-dashboard">
      <div className="oa-toolbar">
        <div className="oa-periods">
          {PERIODS.map(({ days, label }) => (
            <button
              key={label}
              type="button"
              className={`oa-period-btn${period === days ? ' oa-period-btn--active' : ''}`}
              onClick={() => setPeriod(days)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="oa-export-btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {error && <p className="oa-error">{error}</p>}

      {!loading && data && data.kpis?.totalSearches === 0 && (
        <div className="sa-empty-banner">
          <strong>No search data yet for this period.</strong>
          <p>
            Searches are logged from the trade portal (3+ characters, after typing stops) on{' '}
            <a href={PROTO_URLS.site} target="_blank" rel="noopener noreferrer">{PROTO_URLS.site.replace('https://', '')}</a>.
          </p>
        </div>
      )}

      {loading && !data ? (
        <div className="oa-loading"><Loader2 size={20} className="spin" /> Loading search analytics…</div>
      ) : (
        <>
          <div className="oa-stat-grid sa-stat-grid--4">
            <div className="oa-stat-card">
              <div className="oa-stat-val">{kpis?.totalSearches ?? 0}</div>
              <div className="oa-stat-label">Total searches</div>
            </div>
            <div className="oa-stat-card oa-stat-card--accent">
              <div className="oa-stat-val">{kpis?.searchesWithResults ?? 0}</div>
              <div className="oa-stat-label">With results</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{kpis?.searchesNoResults ?? 0}</div>
              <div className="oa-stat-label">No results</div>
            </div>
            <div className="oa-stat-card">
              <div className="oa-stat-val">{kpis?.conversionPct ?? 0}%</div>
              <div className="oa-stat-label">Search → order</div>
            </div>
          </div>

          <div className="oa-panel">
            <PanelHeader title="Search volume (last 10 days)" />
            <TimeBars rows={data?.volumeByDay || []} valueKey="searches" />
          </div>

          <div className="oa-split">
            <div className="oa-panel">
              <PanelHeader title="Search funnel" />
              <FunnelBars funnel={data?.funnel} />
            </div>
            <div className="oa-panel oa-stat-card oa-stat-card--accent" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="oa-stat-val">{money(kpis?.revenue)}</div>
              <div className="oa-stat-label">Revenue attributed to search</div>
            </div>
          </div>

          <div className="oa-split">
            <div className="oa-panel">
              <PanelHeader
                title="Top 10 searches"
                onExport={() => downloadCsv(`proto-top-searches-${dateTag}.csv`, [
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Searches', key: 'searches' },
                  { header: 'Conv %', key: 'conversion' },
                ], data?.topSearches || [])}
              />
              <DataTable
                columns={[
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Count', key: 'searches' },
                  { header: 'Conv %', render: (r) => `${r.conversion ?? 0}%` },
                ]}
                rows={data?.topSearches || []}
              />
            </div>
            <div className="oa-panel">
              <PanelHeader
                title="Top 10 no-result searches"
                onExport={() => downloadCsv(`proto-no-results-${dateTag}.csv`, [
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Count', key: 'search_count' },
                ], data?.zeroResultTerms || [])}
              />
              <DataTable
                columns={[
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Count', key: 'search_count' },
                ]}
                rows={data?.zeroResultTerms || []}
              />
            </div>
          </div>

          <div className="oa-split">
            <div className="oa-panel">
              <PanelHeader
                title="Top 10 searches → orders"
                onExport={() => downloadCsv(`proto-searches-to-orders-${dateTag}.csv`, [
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Searches', key: 'searches' },
                  { header: 'Orders', key: 'orders' },
                ], data?.searchesToOrders || [])}
              />
              <DataTable
                columns={[
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Searches', key: 'searches' },
                  { header: 'Orders', key: 'orders' },
                  { header: 'Conv %', render: (r) => `${r.conversion ?? 0}%` },
                ]}
                rows={data?.searchesToOrders || []}
              />
            </div>
            <div className="oa-panel">
              <PanelHeader
                title="Top 10 searches with no orders"
                onExport={() => downloadCsv(`proto-zero-order-terms-${dateTag}.csv`, [
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Searches', key: 'searches' },
                ], data?.zeroOrderTerms || [])}
              />
              <DataTable
                columns={[
                  { header: 'Term', key: 'normalized_search_term' },
                  { header: 'Searches', key: 'searches' },
                ]}
                rows={data?.zeroOrderTerms || []}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
