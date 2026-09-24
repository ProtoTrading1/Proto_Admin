import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Loader2, RefreshCw, RotateCcw, Search, UserPlus,
} from 'lucide-react';
import { formatWhenLong } from '../../lib/whatsappFormat';

const PAGE_SIZE = 50;

const SOURCE_LABELS = {
  customer_reply: 'Replied STOP',
  wati_contact_sync: 'Turned off in WhatsApp',
  admin: 'Added by an admin',
  failed_delivery: 'Number not on WhatsApp',
};

/**
 * The WhatsApp suppression list.
 *
 * A number here is blocked at the send path itself, not just hidden from this
 * screen, so it cannot be reached by any audience — including a "selected
 * contacts" send from a stale browser tab.
 */
export default function WhatsappOptOuts({ onShowToast, canResubscribe = true }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loading, setLoading] = useState(false);
  const [manualPhone, setManualPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (searchDebounced) params.set('search', searchDebounced);
      const res = await fetch(`/api/whatsapp-opt-outs?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load WhatsApp opt-outs');
      setRows(json.rows || []);
      setTotal(Number(json.total || 0));
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load WhatsApp opt-outs', 'error');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, searchDebounced, onShowToast]);

  useEffect(() => { setPage(1); }, [searchDebounced]);
  useEffect(() => { void load(); }, [load]);

  const addManual = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp-opt-outs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: manualPhone, reason: 'Added by an admin' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not add this number');
      setManualPhone('');
      onShowToast?.(json.existing ? 'That number was already opted out' : 'Number added to the WhatsApp opt-out list');
      await load();
    } catch (err) {
      onShowToast?.(err.message || 'Could not add this number', 'error');
    } finally {
      setSaving(false);
    }
  };

  const resubscribe = async (row) => {
    if (!window.confirm(
      `Allow WhatsApp broadcasts to ${row.phoneDisplay} again?\n\n`
      + 'Only do this if the customer has asked to be put back on the list.',
    )) return;
    setRemoving(row.phone);
    try {
      const res = await fetch(`/api/whatsapp-opt-outs?phone=${encodeURIComponent(row.phone)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not remove this opt-out');
      onShowToast?.('Opt-out lifted — this number can receive broadcasts again');
      await load();
    } catch (err) {
      onShowToast?.(err.message || 'Could not remove this opt-out', 'error');
    } finally {
      setRemoving('');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const columns = canResubscribe ? '1fr 1.3fr 1fr 1.1fr 1fr 130px' : '1fr 1.3fr 1fr 1.1fr 1fr';

  return (
    <div>
      <p className="adm-muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.55 }}>
        Numbers here can never receive a WhatsApp broadcast again — the block is applied on the
        server every time something is sent, so it holds even for a hand-picked list. A customer is
        added automatically when they reply <strong>STOP</strong>, when they switch broadcasts off in
        WhatsApp, or when WhatsApp reports the number cannot receive messages.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <form onSubmit={addManual} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={manualPhone}
            onChange={(e) => setManualPhone(e.target.value)}
            placeholder="082 123 4567"
            aria-label="Phone number to opt out"
            style={{ padding: '8px 11px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', width: 170 }}
          />
          <button type="submit" className="adm-btn-ghost" style={{ fontSize: 13, padding: '7px 13px' }} disabled={saving || !manualPhone.trim()}>
            {saving ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />}
            <span style={{ marginLeft: 6 }}>Add opt-out</span>
          </button>
        </form>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="adm-search adm-search--inline">
            <Search size={14} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number, business…" className="adm-search-input" />
          </label>
          <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: columns }}>
          <span>Number</span><span>Business</span><span>Contact</span><span>Reason</span><span>When</span>
          {canResubscribe && <span>Actions</span>}
        </div>
        {rows.map((row) => (
          <div key={row.phone} className="adm-list-row" style={{ gridTemplateColumns: columns }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{row.phoneDisplay}</div>
            <div style={{ fontSize: 13 }} data-label="Business">{row.businessName || '—'}</div>
            <div style={{ fontSize: 13 }} data-label="Contact">{row.contactName || '—'}</div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="Reason" title={row.reason || ''}>
              {SOURCE_LABELS[row.source] || row.source?.replace(/_/g, ' ') || '—'}
            </div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="When">{formatWhenLong(row.optedOutAt)}</div>
            {canResubscribe && (
              <div data-label="Actions">
                <button
                  type="button"
                  className="adm-btn-ghost"
                  style={{ padding: '5px 8px', fontSize: 12 }}
                  onClick={() => void resubscribe(row)}
                  disabled={removing === row.phone}
                  title="Allow broadcasts to this number again"
                >
                  {removing === row.phone ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
                  <span style={{ marginLeft: 5 }}>Re-allow</span>
                </button>
              </div>
            )}
          </div>
        ))}
        {!loading && rows.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            {searchDebounced ? 'No opt-outs match that search.' : 'Nobody has opted out of WhatsApp yet.'}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            <Loader2 size={16} className="spin" /> Loading opt-outs…
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
