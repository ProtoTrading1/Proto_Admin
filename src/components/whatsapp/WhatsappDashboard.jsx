import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, MessageSquare, MousePointerClick,
  RefreshCw, Send, UserX, Users,
} from 'lucide-react';
import { formatCount, formatPercent, formatWhen, formatWhenLong } from '../../lib/whatsappFormat';

/**
 * WhatsApp CRM overview.
 *
 * The audience block is the honest version of "how big is our list": opted in,
 * minus opted out, minus numbers that cannot receive WhatsApp. A single
 * "contacts" figure would overstate reach by a few hundred.
 */
export default function WhatsappDashboard({ onShowToast, onOpenBroadcast, onOpenTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp-dashboard?days=30');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load the WhatsApp dashboard');
      setData(json);
    } catch (err) {
      onShowToast?.(err.message || 'Failed to load the WhatsApp dashboard', 'error');
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => { void load(); }, [load]);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp-sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Sync failed');
      const bits = [`${formatCount(json.pushedThisRun)} contact${json.pushedThisRun === 1 ? '' : 's'} pushed to WATI`];
      if (json.pushQueueRemaining) bits.push(`${formatCount(json.pushQueueRemaining)} still queued`);
      if (json.newOptOutsFromWati) bits.push(`${json.newOptOutsFromWati} new opt-out${json.newOptOutsFromWati === 1 ? '' : 's'}`);
      if (json.pushFailed) bits.push(`${json.pushFailed} failed`);
      onShowToast?.(bits.join(' · '), json.pushFailed ? 'error' : 'success');
      await load();
    } catch (err) {
      onShowToast?.(err.message || 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 4px', color: '#6b7280', fontSize: 13 }}>
        <Loader2 size={16} className="spin" /> Loading the WhatsApp dashboard…
      </div>
    );
  }
  if (!data) return null;

  const { audience, activity } = data;

  return (
    <div>
      {!data.configured && (
        <div style={notice('#fef3c7', '#f59e0b', '#92400e')}>
          <AlertTriangle size={16} />
          <span>
            <strong>WATI is not connected.</strong> Set <code>WATI_API_TOKEN</code> and{' '}
            <code>WATI_API_URL</code> in Vercel. Contacts and audience figures below are live, but
            nothing can be sent until the token is in place.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="adm-muted" style={{ fontSize: 12 }}>
          Last WATI sync: <strong>{formatWhenLong(data.lastSyncedAt)}</strong>
          {audience.awaitingSync > 0 && (
            <> · {formatCount(audience.awaitingSync)} contact{audience.awaitingSync === 1 ? '' : 's'} still to push</>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="adm-btn-ghost" style={{ fontSize: 13, padding: '7px 14px' }} onClick={runSync} disabled={syncing}>
            {syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            <span style={{ marginLeft: 6 }}>{syncing ? 'Syncing…' : 'Sync contacts to WATI'}</span>
          </button>
          <button type="button" className="adm-btn-red" style={{ fontSize: 13, padding: '7px 14px' }} onClick={onOpenBroadcast}>
            <Send size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            New broadcast
          </button>
        </div>
      </div>

      <h3 style={sectionHeading}>Audience</h3>
      <div className="adm-analytics-grid" style={{ marginBottom: 20 }}>
        <Stat label="Opted in to WhatsApp" value={formatCount(audience.optedIn)} hint="Customers who ticked the WhatsApp box" icon={Users} />
        <Stat label="Reachable now" value={formatCount(audience.reachable)} hint="What a broadcast would actually reach" accent icon={CheckCircle2} />
        <Stat label="Opted out" value={formatCount(audience.optedOut)} hint="Suppressed — can never be broadcast to" icon={UserX} onClick={() => onOpenTab?.('opt-outs')} />
        <Stat label="Unusable number" value={formatCount(audience.unusableNumber)} hint="Landline, malformed, or two numbers in one field" muted icon={AlertTriangle} onClick={() => onOpenTab?.('contacts')} />
        <Stat label="Synced to WATI" value={formatCount(audience.syncedToWati)} hint="Confirmed present in your WATI contact list" muted />
      </div>

      <h3 style={sectionHeading}>Last {data.windowDays} days</h3>
      <div className="adm-analytics-grid" style={{ marginBottom: 20 }}>
        <Stat label="Broadcasts" value={formatCount(activity.broadcasts)} icon={MessageSquare} />
        <Stat label="Messages sent" value={formatCount(activity.sent)} />
        <Stat label="Delivered" value={formatCount(activity.delivered)} hint={`${formatPercent(activity.deliveredRate)} of sent`} />
        <Stat label="Read" value={formatCount(activity.read)} hint={`${formatPercent(activity.readRate)} of sent`} accent />
        <Stat label="Link clicks" value={formatCount(activity.clicked)} hint={`${formatPercent(activity.clickRate)} of sent`} icon={MousePointerClick} />
        <Stat label="Replies" value={formatCount(activity.replied)} />
        <Stat label="Failed" value={formatCount(activity.failed)} muted />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div>
          <h3 style={sectionHeading}>Recent broadcasts</h3>
          {data.recentBroadcasts.length === 0 ? (
            <p className="adm-muted" style={{ fontSize: 13 }}>No broadcasts yet.</p>
          ) : (
            <div className="adm-list">
              {data.recentBroadcasts.map((b) => (
                <div key={b.id} className="adm-list-row" style={{ gridTemplateColumns: '1.6fr 0.8fr 0.8fr 0.8fr' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {b.name}
                    <div className="adm-muted" style={{ fontSize: 11, fontWeight: 400 }}>{formatWhen(b.createdAt)} · {b.templateName}</div>
                  </div>
                  <div className="adm-muted" style={{ fontSize: 12 }} data-label="Sent">{formatCount(b.sent)} sent</div>
                  <div className="adm-muted" style={{ fontSize: 12 }} data-label="Clicks">{formatCount(b.clicked)} clicks</div>
                  <div className="adm-muted" style={{ fontSize: 12 }} data-label="Failed">{b.failed ? `${formatCount(b.failed)} failed` : '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 style={sectionHeading}>Latest opt-outs</h3>
          {data.recentOptOuts.length === 0 ? (
            <p className="adm-muted" style={{ fontSize: 13 }}>Nobody has opted out yet.</p>
          ) : (
            <div className="adm-list">
              {data.recentOptOuts.map((row) => (
                <div key={row.phone} className="adm-list-row" style={{ gridTemplateColumns: '1.1fr 1fr 0.9fr' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{row.phoneDisplay}</div>
                  <div className="adm-muted" style={{ fontSize: 12 }} data-label="Source">{row.source?.replace(/_/g, ' ')}</div>
                  <div className="adm-muted" style={{ fontSize: 12 }} data-label="When">{formatWhen(row.optedOutAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const sectionHeading = {
  fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: '#64748b', margin: '0 0 8px',
};

function notice(bg, border, fg) {
  return {
    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 14,
    background: bg, border: `1px solid ${border}`, borderRadius: 10, color: fg, fontSize: 13, lineHeight: 1.5,
  };
}

function Stat({ label, value, hint, accent, muted, icon: Icon, onClick }) {
  const className = `adm-analytics-card${accent ? ' adm-analytics-card--accent' : muted ? ' adm-analytics-card--muted' : ''}`;
  const body = (
    <>
      <div className="adm-analytics-value">{value}</div>
      <div className="adm-analytics-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {Icon && <Icon size={12} />}
        {label}
      </div>
      {hint && <div className="adm-muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.35 }}>{hint}</div>}
    </>
  );
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button type="button" className={className} onClick={onClick} style={{ border: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
      {body}
    </button>
  );
}
