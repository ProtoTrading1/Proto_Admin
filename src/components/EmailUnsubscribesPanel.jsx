import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export default function EmailUnsubscribesPanel({ onShowToast }) {
  const [allRows, setAllRows] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loading, setLoading] = useState(false);
  const [manualEmail, setManualEmail] = useState('');
  const [savingManualEmail, setSavingManualEmail] = useState(false);
  const toastRef = useRef(onShowToast);
  toastRef.current = onShowToast;
  const requestRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      // Fetch one complete, authenticated snapshot. Paging/searching it must
      // not repeat the full Brevo scan for each screen of 50 contacts.
      const params = new URLSearchParams({ all: '1' });
      const res = await fetch(`/api/email-unsubscribes?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load unsubscribed contacts');
      if (requestId !== requestRef.current) return;
      setAllRows(json.rows || []);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLoadError(err.message || 'Failed to load unsubscribed contacts');
      toastRef.current?.(err.message || 'Failed to load unsubscribed contacts', 'error');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { setPage(1); }, [searchDebounced]);
  useEffect(() => {
    void load();
    return () => { requestRef.current += 1; };
  }, [load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'comms') void load();
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [load]);

  async function handleAddManualEmail(event) {
    event.preventDefault();
    const email = manualEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      onShowToast?.('Enter a valid email address', 'error');
      return;
    }
    setSavingManualEmail(true);
    try {
      const res = await fetch('/api/email-unsubscribes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to add unsubscribed email');
      setManualEmail('');
      onShowToast?.('Email added to unsubscribed contacts', 'success');
      await load();
      setPage(1);
    } catch (err) {
      onShowToast?.(err.message || 'Failed to add unsubscribed email', 'error');
    } finally {
      setSavingManualEmail(false);
    }
  }

  const filteredRows = useMemo(() => allRows.filter((row) => !searchDebounced ||
    [row.email, row.business_name, row.contact_name].some((value) =>
      String(value || '').toLowerCase().includes(searchDebounced.toLowerCase()))), [allRows, searchDebounced]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const rows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserX size={17} /> Unsubscribed
          </h3>
          <p className="adm-section-note" style={{ margin: '4px 0 0' }}>
            All contacts on Brevo's marketing suppression list, merged with Proto's signed unsubscribe records.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <form onSubmit={handleAddManualEmail} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input value={manualEmail} onChange={(e) => setManualEmail(e.target.value)} placeholder="Add email manually..." type="email" className="adm-search-input" style={{ minWidth: 190, border: '1px solid #d1d5db', borderRadius: 4, padding: '7px 9px' }} aria-label="Add email manually" />
            <button type="submit" className="adm-btn-ghost" disabled={savingManualEmail || !manualEmail.trim()}>{savingManualEmail ? 'Adding...' : 'Add'}</button>
          </form>
          <label className="adm-search adm-search--inline">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email..." className="adm-search-input" />
          </label>
          <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load()} disabled={loading || savingManualEmail} title="Reload unsubscribed contacts">
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {loadError && <p role="alert" style={{ color: '#b91c1c' }}>{loadError}. Use reload to try again; any previously loaded records may be out of date.</p>}
      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: '1.2fr 1fr 1.4fr 180px' }}>
          <span>Business</span><span>Contact</span><span>Email</span><span>Unsubscribed</span>
        </div>
        {rows.map((row) => (
          <div key={`${row.email}-${row.unsubscribed_at || row.created_at}`} className="adm-list-row" style={{ gridTemplateColumns: '1.2fr 1fr 1.4fr 180px' }}>
            <div data-label="Business" style={{ fontSize: 13, fontWeight: 600 }}>{row.business_name || '-'}</div>
            <div data-label="Contact" style={{ fontSize: 13 }}>{row.contact_name || '-'}</div>
            <div data-label="Email" style={{ fontSize: 12, wordBreak: 'break-all' }}>{row.email}</div>
            <div data-label="Unsubscribed" className="adm-muted" style={{ fontSize: 12 }}>{formatWhen(row.unsubscribed_at)}</div>
          </div>
        ))}
        {!loading && !loadError && rows.length === 0 && (
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
          <span className="adm-muted" style={{ fontSize: 12 }}>Page {currentPage} of {totalPages}</span>
          <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}


