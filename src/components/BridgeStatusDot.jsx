import { useEffect, useRef, useState } from 'react';

/**
 * Small live-status dot for the admin header showing whether the Positill SQL
 * bridge (Cloudflare tunnel on BLADERUNNER) is reachable.
 *   green  = bridge online (SQL connection test passed)
 *   red    = bridge configured but unreachable / offline
 *   grey   = not configured, still checking, or not permitted (owner-gated)
 *
 * Reuses the existing owner-only /api/product-loader-diag endpoint, polled
 * infrequently so it never gets in the way.
 */
const POLL_MS = 120000;

export default function BridgeStatusDot() {
  const [state, setState] = useState('loading'); // loading | online | offline | unknown
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/bridge-status', { headers: { Accept: 'application/json' } });
        if (!res.ok) { if (!cancelled) setState('unknown'); return; }
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (json?.online) setState('online');
        else if (json?.configured) setState('offline');
        else setState('unknown');
      } catch {
        if (!cancelled) setState('unknown');
      }
    };

    void check();
    timerRef.current = setInterval(check, POLL_MS);
    return () => { cancelled = true; if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const meta = {
    loading: { color: '#cbd5e1', label: 'Bridge — checking…', pulse: true },
    online: { color: '#16a34a', label: 'Bridge online — live Positill SQL connected', pulse: false },
    offline: { color: '#dc2626', label: 'Bridge offline — live SQL unreachable (check Cloudflare tunnel on BLADERUNNER)', pulse: false },
    unknown: { color: '#cbd5e1', label: 'Bridge status unavailable', pulse: false },
  }[state];

  return (
    <span
      className="adm-bridge-dot"
      title={meta.label}
      aria-label={meta.label}
      role="img"
    >
      <span
        className={`adm-bridge-dot__led${meta.pulse ? ' adm-bridge-dot__led--pulse' : ''}`}
        style={{ background: meta.color, boxShadow: `0 0 0 3px ${meta.color}22` }}
      />
      <span className="adm-bridge-dot__label">Bridge</span>
    </span>
  );
}
