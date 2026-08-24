import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, UserX } from 'lucide-react';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';

const PAGE_SIZE = 50;

function formatWhen(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(value) {
  const raw = String(value || '').trim();
  if (raw === 'email_unsubscribe_link') return 'Email link';
  return raw || '-';
}

export default function EmailUnsubscribesPanel({ onShowToast }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (pageArg = page, searchArg = searchDebounced) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(pageArg),
        pageSize: String(PAGE_SIZE),
      });
      if (searchArg) params.set('search', searchArg);
      const res = await fetch(`/api/email-unsubscribes?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load unsubscribed contacts');
      setRows(json.rows || []);
      setTotal(Number(json.total || 0));
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load unsubscribed contacts', 'error');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [onShowToast, page, searchDebounced]);

  useEffect(() => { setPage(1); }, [searchDebounced]);
  useEffect(() => { void load(page, searchDebounced); }, [load, page, searchDebounced]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'comms') void load(page, searchDebounced);
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load, page, searchDebounced]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserX size={17} /> Unsubscribed
          </h3>
          <p className="adm-section-note" style={{ margin: '4px 0 0' }}>
            Contacts who opted out of backend marketing broadcasts.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="adm-search adm-search--inline">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email..." className="adm-search-input" />
          </label>
          <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load(page, searchDebounced)} disabled={loading} title="Reload unsubscribed contacts">
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: '1.5fr 150px 180px 180px' }}>
          <span>Email</span><span>Source</span><span>Unsubscribed</span><span>Created</span>
        </div>
        {rows.map((row) => (
          <div key={`${row.email}-${row.unsubscribed_at || row.created_at}`} className="adm-list-row" style={{ gridTemplateColumns: '1.5fr 150px 180px 180px' }}>
            <div data-label="Email" style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}>{row.email}</div>
            <div data-label="Source" className="adm-muted" style={{ fontSize: 12 }}>{sourceLabel(row.source)}</div>
            <div data-label="Unsubscribed" className="adm-muted" style={{ fontSize: 12 }}>{formatWhen(row.unsubscribed_at)}</div>
            <div data-label="Created" className="adm-muted" style={{ fontSize: 12 }}>{formatWhen(row.created_at)}</div>
          </div>
        ))}
        {!loading && rows.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            {searchDebounced ? 'No unsubscribed contacts match this search.' : 'No unsubscribed contacts yet.'}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            <Loader2 size={16} className="spin" /> Loading unsubscribed contacts...
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
            <ChevronLeft size={14} />
          </button>
          <span className="adm-muted" style={{ fontSize: 12 }}>Page {page} of {totalPages}</span>
          <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}


