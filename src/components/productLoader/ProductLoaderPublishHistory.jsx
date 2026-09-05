import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { fetchPublishHistory } from '../../lib/productLoaderApi';
import LoaderCodeEllipsis from './LoaderCodeEllipsis.jsx';

const ACTION_FILTERS = [
  { id: '', label: 'All actions' },
  { id: 'published', label: 'Published' },
  { id: 'dormant', label: 'Dormant' },
  { id: 'failed', label: 'Failed' },
];

export default function ProductLoaderPublishHistory({
  onShowToast,
  onRerun,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [sku, setSku] = useState('');
  const [action, setAction] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = await fetchPublishHistory({ q, sku, action, limit: 100 });
      setRows(json.rows || []);
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load history', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [q, sku, action, onShowToast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="pl-section">
      <div className="pl-history-filters">
        <label className="adm-search">
          <Search size={14} />
          <input className="adm-search-input" placeholder="Search SKU, filename, reason…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <input className="adm-search-input" placeholder="SKU filter" value={sku} onChange={(e) => setSku(e.target.value)} />
        <select className="adm-select adm-select--enhanced" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTION_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      <div className="pl-folder-table-wrap">
        <table className="pl-folder-table">
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '28%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: 56 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>User</th>
              <th>SKU</th>
              <th>Filename</th>
              <th>Action</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.date ? new Date(row.date).toLocaleString() : '—'}</td>
                <td>{row.user}</td>
                <td className="pl-table-clip"><LoaderCodeEllipsis value={row.sku} fill /></td>
                <td className="pl-table-clip">
                  <LoaderCodeEllipsis value={row.filename} strong={false} fill />
                </td>
                <td><span className={`pl-history-action pl-history-action--${row.action}`}>{row.action}</span></td>
                <td>{row.reason || '—'}</td>
                <td>
                  {row.action === 'failed' && (
                    <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => onRerun?.(row.sku)}>
                      Re-run
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && !rows.length && (
              <tr><td colSpan={7} className="adm-muted">No publish history yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
