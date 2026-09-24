import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Loader2, MousePointerClick, RefreshCw,
} from 'lucide-react';
import WhatsappStatusPill from './WhatsappStatusPill';
import { formatCount, formatPercent, formatWhen, formatWhenLong } from '../../lib/whatsappFormat';

const HISTORY_PAGE_SIZE = 25;
const RECIPIENT_PAGE_SIZE = 100;

/**
 * Broadcast analytics: the list of sends, and the funnel for one send.
 *
 * The funnel is recomputed from the recipient rows on every load rather than
 * read off the broadcast's counters, because WhatsApp delivery and read receipts
 * keep arriving for minutes — sometimes hours — after the send finishes.
 */
export default function WhatsappAnalytics({ onShowToast, focusBroadcastId = null }) {
  const [selectedId, setSelectedId] = useState(focusBroadcastId);

  useEffect(() => { if (focusBroadcastId) setSelectedId(focusBroadcastId); }, [focusBroadcastId]);

  return selectedId
    ? <BroadcastDetail broadcastId={selectedId} onBack={() => setSelectedId(null)} onShowToast={onShowToast} />
    : <BroadcastHistory onOpen={setSelectedId} onShowToast={onShowToast} />;
}

function BroadcastHistory({ onOpen, onShowToast }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(HISTORY_PAGE_SIZE) });
      const res = await fetch(`/api/whatsapp-broadcast?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load broadcasts');
      setRows(json.rows || []);
      setTotal(Number(json.total || 0));
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load broadcasts', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, onShowToast]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const columns = '1.6fr 1fr 0.7fr 0.7fr 0.7fr 0.7fr 0.9fr';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p className="adm-muted" style={{ fontSize: 12, margin: 0 }}>
          Every broadcast, with what WhatsApp reported back. Open one to see who read it and who
          clicked.
        </p>
        <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: columns }}>
          <span>Broadcast</span><span>Template</span><span>Targeted</span><span>Sent</span>
          <span>Clicks</span><span>Failed</span><span>When</span>
        </div>
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="adm-list-row"
            onClick={() => onOpen(row.id)}
            style={{ gridTemplateColumns: columns, textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid #f1f5f9', cursor: 'pointer', font: 'inherit', width: '100%' }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {row.name}
              {row.status !== 'completed' && (
                <span className="adm-muted" style={{ fontSize: 11, fontWeight: 400, display: 'block' }}>{row.status}</span>
              )}
            </div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="Template">{row.templateName}</div>
            <div style={{ fontSize: 12 }} data-label="Targeted">{formatCount(row.targeted)}</div>
            <div style={{ fontSize: 12 }} data-label="Sent">{formatCount(row.sent)}</div>
            <div style={{ fontSize: 12 }} data-label="Clicks">{row.trackedUrl ? formatCount(row.clicked ?? 0) : '—'}</div>
            <div style={{ fontSize: 12, color: row.failed ? '#991b1b' : undefined }} data-label="Failed">{row.failed ? formatCount(row.failed) : '—'}</div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="When">{formatWhen(row.createdAt)}</div>
          </button>
        ))}
        {!loading && rows.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            No broadcasts sent yet. Send one from the Broadcast tab and its analytics will appear here.
          </div>
        )}
        {loading && rows.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            <Loader2 size={16} className="spin" /> Loading broadcasts…
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <Pager page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
      )}
    </div>
  );
}

function BroadcastDetail({ broadcastId, onBack, onShowToast }) {
  const [broadcast, setBroadcast] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [clickedOnly, setClickedOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        id: broadcastId, page: String(page), pageSize: String(RECIPIENT_PAGE_SIZE),
      });
      if (statusFilter) params.set('status', statusFilter);
      if (clickedOnly) params.set('clicked', 'true');
      const res = await fetch(`/api/whatsapp-broadcast?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load this broadcast');
      setBroadcast(json.broadcast);
      setRecipients(json.recipients || []);
      setTotal(Number(json.total || 0));
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load this broadcast', 'error');
    } finally {
      setLoading(false);
    }
  }, [broadcastId, page, statusFilter, clickedOnly, onShowToast]);

  useEffect(() => { setPage(1); }, [statusFilter, clickedOnly]);
  useEffect(() => { void load(); }, [load]);

  if (loading && !broadcast) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 4px', color: '#6b7280', fontSize: 13 }}>
        <Loader2 size={16} className="spin" /> Loading broadcast…
      </div>
    );
  }
  if (!broadcast) return null;

  const { funnel } = broadcast;
  const rate = (part) => (funnel.sent > 0 ? Math.round((part / funnel.sent) * 1000) / 10 : 0);
  const totalPages = Math.max(1, Math.ceil(total / RECIPIENT_PAGE_SIZE));
  const columns = '1.3fr 1fr 1fr 0.9fr 0.9fr 0.8fr';

  return (
    <div>
      <button type="button" className="adm-btn-ghost" style={{ fontSize: 12, padding: '5px 11px', marginBottom: 14 }} onClick={onBack}>
        <ArrowLeft size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
        All broadcasts
      </button>

      <div style={{ marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{broadcast.name}</h3>
        <p className="adm-muted" style={{ fontSize: 12, margin: 0 }}>
          {broadcast.templateName} · sent {formatWhenLong(broadcast.startedAt || broadcast.createdAt)}
          {broadcast.createdBy ? ` by ${broadcast.createdBy}` : ''}
          {broadcast.skipped ? ` · ${formatCount(broadcast.skipped)} opted-in contacts held back` : ''}
        </p>
        {broadcast.bodyPreview && (
          <div style={{
            marginTop: 10, background: '#dcf8c6', border: '1px solid #b7e0a0', borderRadius: '12px 12px 12px 2px',
            padding: '10px 13px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: '#1f2937', maxWidth: 520,
          }}
          >
            {broadcast.bodyPreview}
          </div>
        )}
      </div>

      <div className="adm-analytics-grid" style={{ marginBottom: 16 }}>
        <Metric label="Targeted" value={formatCount(funnel.targeted)} />
        <Metric label="Sent" value={formatCount(funnel.sent)} />
        <Metric label="Delivered" value={formatCount(funnel.delivered)} hint={`${formatPercent(rate(funnel.delivered))} of sent`} />
        <Metric label="Read" value={formatCount(funnel.read)} hint={`${formatPercent(rate(funnel.read))} of sent`} accent />
        <Metric label="Link clicks" value={broadcast.trackedUrl ? formatCount(funnel.clicked) : '—'} hint={broadcast.trackedUrl ? `${formatPercent(rate(funnel.clicked))} of sent` : 'No tracked link'} />
        <Metric label="Replies" value={formatCount(funnel.replied)} />
        <Metric label="Failed" value={formatCount(funnel.failed)} muted />
      </div>

      {broadcast.trackedUrl && (
        <p className="adm-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          <MousePointerClick size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          Tracked link destination: <a href={broadcast.trackedUrl} target="_blank" rel="noreferrer noopener">{broadcast.trackedUrl}</a>
        </p>
      )}

      <div className="adm-customer-tabs" style={{ marginBottom: 12 }}>
        {[
          { value: '', label: 'Everyone' },
          { value: 'read', label: 'Read' },
          { value: 'delivered', label: 'Delivered' },
          { value: 'sent', label: 'Sent only' },
          { value: 'failed', label: 'Failed' },
        ].map((option) => (
          <button
            key={option.value || 'all'}
            type="button"
            className={`adm-tab${statusFilter === option.value && !clickedOnly ? ' adm-tab--active' : ''}`}
            onClick={() => { setStatusFilter(option.value); setClickedOnly(false); }}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className={`adm-tab${clickedOnly ? ' adm-tab--active' : ''}`}
          onClick={() => { setClickedOnly(true); setStatusFilter(''); }}
          disabled={!broadcast.trackedUrl}
          title={broadcast.trackedUrl ? 'Only recipients who clicked the link' : 'This broadcast had no tracked link'}
        >
          <MousePointerClick size={13} style={{ marginRight: 5, verticalAlign: -2 }} />
          Clicked
        </button>
      </div>

      <div className="adm-list">
        <div className="adm-list-head" style={{ gridTemplateColumns: columns }}>
          <span>Business</span><span>Contact</span><span>Number</span><span>Status</span><span>Read</span><span>Clicks</span>
        </div>
        {recipients.map((row) => (
          <div key={row.phone} className="adm-list-row" style={{ gridTemplateColumns: columns }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{row.businessName || '—'}</div>
            <div style={{ fontSize: 13 }} data-label="Contact">{row.contactName || '—'}</div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="Number">{row.phoneDisplay}</div>
            <div data-label="Status">
              <WhatsappStatusPill status={row.status} />
              {row.error && <div style={{ fontSize: 11, color: '#991b1b', marginTop: 3 }}>{row.error}</div>}
            </div>
            <div className="adm-muted" style={{ fontSize: 12 }} data-label="Read">{formatWhen(row.readAt)}</div>
            <div style={{ fontSize: 12, fontWeight: row.clickCount ? 700 : 400 }} data-label="Clicks">
              {row.clickCount ? `${row.clickCount}×` : '—'}
              {row.lastClickedAt && <div className="adm-muted" style={{ fontSize: 11, fontWeight: 400 }}>{formatWhen(row.lastClickedAt)}</div>}
            </div>
          </div>
        ))}
        {!loading && recipients.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
            No recipients match this filter.
          </div>
        )}
      </div>

      {totalPages > 1 && <Pager page={page} totalPages={totalPages} loading={loading} onChange={setPage} />}
    </div>
  );
}

function Metric({ label, value, hint, accent, muted }) {
  return (
    <div className={`adm-analytics-card${accent ? ' adm-analytics-card--accent' : muted ? ' adm-analytics-card--muted' : ''}`}>
      <div className="adm-analytics-value">{value}</div>
      <div className="adm-analytics-label">{label}</div>
      {hint && <div className="adm-muted" style={{ fontSize: 11, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Pager({ page, totalPages, loading, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
      <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page <= 1 || loading} onClick={() => onChange(Math.max(1, page - 1))} aria-label="Previous page">
        <ChevronLeft size={14} />
      </button>
      <span className="adm-muted" style={{ fontSize: 12 }}>Page {page} of {totalPages}</span>
      <button type="button" className="adm-btn-ghost" style={{ padding: '4px 10px' }} disabled={page >= totalPages || loading} onClick={() => onChange(Math.min(totalPages, page + 1))} aria-label="Next page">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
