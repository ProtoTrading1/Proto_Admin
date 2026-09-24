import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, Send, UserMinus,
} from 'lucide-react';
import AdminSelect from '../AdminSelect';
import { BUSINESS_TYPES } from '../../lib/businessTypes';
import { formatWhen } from '../../lib/whatsappFormat';

const PAGE_SIZE = 50;

const FILTERS = [
  { value: 'sendable', label: 'Reachable' },
  { value: 'blocked', label: 'Not reachable' },
  { value: 'all', label: 'Everyone opted in' },
];

/**
 * WhatsApp contacts — every customer who ticked the opt-in, and whether we can
 * actually reach them.
 *
 * The "Not reachable" filter is the useful one: it names each reason (opted out,
 * landline, two numbers in one field) so the list can be cleaned up, instead of
 * those customers just quietly missing from every broadcast.
 */
export default function WhatsappContacts({ onShowToast, onBroadcastToSelection }) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('sendable');
  const [businessType, setBusinessType] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [optingOut, setOptingOut] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page), pageSize: String(PAGE_SIZE), filter,
      });
      if (businessType) params.set('business_type', businessType);
      if (searchDebounced) params.set('search', searchDebounced);
      const res = await fetch(`/api/whatsapp-contacts?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load WhatsApp contacts');
      setRows(json.rows || []);
      setTotal(Number(json.total || 0));
      setCounts(json.counts || null);
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load WhatsApp contacts', 'error');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, filter, businessType, searchDebounced, onShowToast]);

  useEffect(() => { setPage(1); }, [filter, businessType, searchDebounced]);
  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectablePhones = useMemo(() => rows.filter((r) => r.sendable).map((r) => r.phone), [rows]);
  const allPageSelected = selectablePhones.length > 0 && selectablePhones.every((p) => selected.has(p));

  const toggleOne = (phone) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(phone)) next.delete(phone); else next.add(phone);
    return next;
  });

  const togglePage = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allPageSelected) selectablePhones.forEach((p) => next.delete(p));
    else selectablePhones.forEach((p) => next.add(p));
    return next;
  });

  const optOut = async (row) => {
    if (!window.confirm(`Stop sending WhatsApp broadcasts to ${row.phoneDisplay}${row.businessName ? ` (${row.businessName})` : ''}?`)) return;
    setOptingOut(row.phone);
    try {
      const res = await fetch('/api/whatsapp-opt-outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: row.phone, customerId: row.customerId, email: row.email, reason: 'Opted out by an admin' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not opt this contact out');
      setSelected((prev) => { const next = new Set(prev); next.delete(row.phone); return next; });
      onShowToast?.('Contact opted out of WhatsApp broadcasts');
      await load();
    } catch (err) {
      onShowToast?.(err.message || 'Could not opt this contact out', 'error');
    } finally {
      setOptingOut('');
    }
  };

  const columns = '34px 1.3fr 1fr 1fr 1.1fr 0.9fr 118px';

  return (
    <div>
      {counts && (
        <div className="crm-campaign-summary" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
          <strong>{counts.sendable.toLocaleString('en-ZA')} reachable</strong>
          <span>{counts.optedOut.toLocaleString('en-ZA')} opted out</span>
          <span>{counts.unusableNumber.toLocaleString('en-ZA')} unusable number</span>
        </div>
      )}

      <div className="adm-customer-tabs" style={{ marginBottom: 12 }}>
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`adm-tab${filter === option.value ? ' adm-tab--active' : ''}`}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
        <AdminSelect
          ariaLabel="Filter by business type"
          value={businessType}
          onChange={setBusinessType}
          options={[{ value: '', label: 'All business types' }, ...BUSINESS_TYPES.map((t) => ({ value: t, label: t }))]}
        />
        <label className="adm-search adm-search--inline">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, business, number…" className="adm-search-input" />
        </label>
        <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load()} disabled={loading} title="Reload contacts">
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
      }}
      >
        <div style={{ fontSize: 13, color: '#334155' }}>
          {selected.size > 0 ? (
            <>
              <strong>{selected.size}</strong> contact{selected.size === 1 ? '' : 's'} selected
              <button type="button" onClick={() => setSelected(new Set())} style={{ marginLeft: 8, background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0 }}>clear</button>
            </>
          ) : 'Tick reachable contacts to broadcast to just those people.'}
        </div>
        <button
          type="button"
          className="adm-btn-red"
          style={{ fontSize: 13, padding: '7px 14px', opacity: selected.size ? 1 : 0.5 }}
          disabled={!selected.size}
          onClick={() => onBroadcastToSelection?.([...selected])}
        >
          <Send size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          Broadcast to selected ({selected.size})
        </button>
      </div>

      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: columns }}>
          <span>
            <input type="checkbox" checked={allPageSelected} onChange={togglePage} disabled={!selectablePhones.length} aria-label="Select all reachable contacts on this page" style={{ accentColor: '#dc2626' }} />
          </span>
          <span>Business</span><span>Contact</span><span>WhatsApp number</span><span>Status</span><span>Last broadcast</span><span>Actions</span>
        </div>

        {rows.map((row) => (
          <div key={`${row.phone || row.customerId}`} className="adm-list-row" style={{ gridTemplateColumns: columns }}>
            <span data-label="Select">
              <input
                type="checkbox"
                checked={selected.has(row.phone)}
                onChange={() => toggleOne(row.phone)}
                disabled={!row.sendable}
                aria-label={`Select ${row.businessName || row.phoneDisplay}`}
                style={{ accentColor: '#dc2626' }}
              />
            </span>
            <div data-label="Business" style={{ fontSize: 13, fontWeight: 600 }}>{row.businessName || '—'}</div>
            <div data-label="Contact" style={{ fontSize: 13 }}>{row.contactName || '—'}</div>
            <div data-label="Number" style={{ fontSize: 12, color: row.sendable ? undefined : '#94a3b8' }}>
              {row.phoneDisplay}
              {row.phoneKind === 'sa_landline' && <span className="adm-muted" style={{ fontSize: 11, display: 'block' }}>landline</span>}
            </div>
            <div data-label="Status" style={{ fontSize: 12 }}>
              {row.sendable ? (
                <SyncBadge status={row.syncStatus} error={row.syncError} />
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#991b1b', fontWeight: 600, fontSize: 11 }}>
                  <AlertTriangle size={12} /> {row.blockedReason}
                </span>
              )}
            </div>
            <div data-label="Last broadcast" className="adm-muted" style={{ fontSize: 12 }}>{formatWhen(row.lastBroadcastAt)}</div>
            <div data-label="Actions">
              {row.sendable && (
                <button
                  type="button"
                  className="adm-btn-ghost"
                  style={{ padding: '5px 8px', fontSize: 12 }}
                  onClick={() => void optOut(row)}
                  disabled={optingOut === row.phone}
                  title="Stop WhatsApp broadcasts to this number"
                >
                  {optingOut === row.phone ? <Loader2 size={13} className="spin" /> : <UserMinus size={13} />}
                  <span style={{ marginLeft: 5 }}>Opt out</span>
                </button>
              )}
            </div>
          </div>
        ))}

        {!loading && rows.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            {filter === 'blocked'
              ? 'Every opted-in customer has a usable number and none have opted out.'
              : searchDebounced || businessType
                ? 'No opted-in contacts match this filter.'
                : 'No customers have opted in to WhatsApp yet.'}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            <Loader2 size={16} className="spin" /> Loading contacts…
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

const SYNC_TONES = {
  synced: { bg: '#dcfce7', fg: '#166534', label: 'In WATI' },
  pending: { bg: '#f1f5f9', fg: '#475569', label: 'Not synced yet' },
  failed: { bg: '#fee2e2', fg: '#991b1b', label: 'Sync failed' },
  not_whatsapp: { bg: '#fef3c7', fg: '#92400e', label: 'No WhatsApp' },
};

function SyncBadge({ status, error }) {
  const tone = SYNC_TONES[status] || SYNC_TONES.pending;
  return (
    <span
      title={error || undefined}
      style={{ background: tone.bg, color: tone.fg, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap' }}
    >
      {tone.label}
    </span>
  );
}
