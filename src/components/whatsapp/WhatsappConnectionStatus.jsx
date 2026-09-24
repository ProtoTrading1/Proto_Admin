import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { formatWhenLong } from '../../lib/whatsappFormat';

/**
 * "Is WhatsApp connected?" button for the CRM header.
 *
 *   green  = we just made a real authenticated call to WATI and it worked
 *   amber  = WATI is reachable, but delivery/read/click data is not coming back
 *            (webhook secret missing or mistyped in WATI)
 *   red    = a token is set but WATI rejected it or could not be reached
 *   grey   = no token set yet, or still checking
 *
 * Green deliberately means "we just talked to WATI", not "an env var exists" —
 * an expired token looks configured and fails only at send time, which is the
 * worst moment to find out.
 *
 * Click it to see the detail and force a re-check.
 */

const POLL_MS = 120_000;

export default function WhatsappConnectionStatus({ onStatus }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/whatsapp-status', { headers: { Accept: 'application/json' } });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || 'Status check failed');
      setStatus(json);
      onStatus?.(json);
    } catch {
      // A failed status check is itself a status, not an error to shout about.
      setStatus({ configured: false, connected: false, reason: 'Could not reach the status check.' });
    } finally {
      setChecking(false);
    }
  }, [onStatus]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => { void check(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [check]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tone = resolveTone(status, checking);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`WhatsApp connection: ${tone.label}`}
        title={status?.reason || tone.label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
          background: tone.bg, border: `1.5px solid ${tone.border}`, color: tone.fg,
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            width: 9, height: 9, borderRadius: '50%', background: tone.dot,
            boxShadow: `0 0 0 3px ${tone.dot}33`, flexShrink: 0,
          }}
        />
        {tone.label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="WhatsApp connection detail"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 40, width: 310,
            background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)', padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#0f172a' }}>
            {tone.headline}
          </div>

          {status?.reason && (
            <p style={{ fontSize: 12, lineHeight: 1.55, color: '#475569', margin: '0 0 10px' }}>
              {status.reason}
            </p>
          )}

          <dl style={{ margin: 0, fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
            <Row label="WATI account" value={status?.tenantId || '—'} />
            <Row
              label="Approved templates"
              value={status?.connected ? String(status.templates?.approved ?? 0) : '—'}
            />
            <Row
              label="Webhook secret"
              value={status?.webhook?.secretConfigured ? 'Set' : 'Not set'}
            />
            <Row
              label="Last event in"
              value={status?.webhook?.lastEventAt ? formatWhenLong(status.webhook.lastEventAt) : 'Never'}
            />
            <Row label="Events (7 days)" value={String(status?.webhook?.eventsLast7Days ?? 0)} />
          </dl>

          <button
            type="button"
            className="adm-btn-ghost"
            style={{ fontSize: 12, padding: '6px 12px', marginTop: 12, width: '100%' }}
            onClick={() => void check()}
            disabled={checking}
          >
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            <span style={{ marginLeft: 6 }}>{checking ? 'Checking…' : 'Check again'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <dt style={{ color: '#94a3b8' }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600, color: '#334155', textAlign: 'right' }}>{value}</dd>
    </div>
  );
}

function resolveTone(status, checking) {
  if (checking && !status) {
    return {
      label: 'Checking…', headline: 'Checking the WATI connection',
      dot: '#cbd5e1', bg: '#f8fafc', border: '#e2e8f0', fg: '#64748b',
    };
  }
  if (!status?.configured) {
    return {
      label: 'Not connected', headline: 'WATI is not connected',
      dot: '#94a3b8', bg: '#f8fafc', border: '#e2e8f0', fg: '#475569',
    };
  }
  if (!status.connected) {
    return {
      label: 'Connection failed', headline: 'WATI rejected the connection',
      dot: '#dc2626', bg: '#fef2f2', border: '#fecaca', fg: '#991b1b',
    };
  }
  // Reachable, but nothing is coming back — sending will work while every
  // broadcast reports 0 delivered and 0 read.
  if (!status.webhook?.lastEventAt) {
    return {
      label: 'Connected · no events', headline: 'Connected, but no webhook events yet',
      dot: '#f59e0b', bg: '#fffbeb', border: '#fde68a', fg: '#92400e',
    };
  }
  return {
    label: 'WhatsApp connected', headline: 'Connected to WATI',
    dot: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', fg: '#166534',
  };
}
