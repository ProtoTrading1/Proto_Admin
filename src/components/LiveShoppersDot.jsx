import { useEffect, useRef, useState } from 'react';

/**
 * Live count of signed-in customers browsing the storefront right now, shown
 * beside the bridge status in the admin header.
 *
 * The storefront heartbeats once a minute per visible tab; /api/live-shoppers
 * counts the rows still inside its freshness window. Polling every 20s keeps
 * the number feeling live without being the busiest thing on the page — the
 * underlying data only changes on the customer's minute-long beat anyway.
 *
 * Reuses .adm-bridge-dot so it reads as one pair of status pills, not two
 * different widgets that happen to sit together.
 */
const POLL_MS = 20000;

export default function LiveShoppersDot() {
  const [state, setState] = useState({ status: 'loading', count: 0 });
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/live-shoppers', { headers: { Accept: 'application/json' } });
        if (!res.ok) { if (!cancelled) setState({ status: 'unknown', count: 0 }); return; }
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!json || json.available === false) { setState({ status: 'unavailable', count: 0 }); return; }
        setState({ status: 'ok', count: Number(json.count) || 0 });
      } catch {
        if (!cancelled) setState({ status: 'unknown', count: 0 });
      }
    };

    void check();
    timerRef.current = setInterval(check, POLL_MS);
    return () => { cancelled = true; if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const { status, count } = state;

  // Grey when we cannot tell, green when someone is on the site, and a quiet
  // slate when the shop is genuinely empty — an empty shop is not a fault.
  const meta = {
    loading: { color: '#cbd5e1', pulse: true, text: '—', label: 'Live shoppers — checking…' },
    unknown: { color: '#cbd5e1', pulse: false, text: '—', label: 'Live shopper count unavailable' },
    unavailable: {
      color: '#cbd5e1',
      pulse: false,
      text: '—',
      label: 'Live shoppers — waiting on the storefront presence release',
    },
    ok: count > 0
      ? {
        color: '#16a34a',
        pulse: true,
        text: String(count),
        label: `${count} signed-in ${count === 1 ? 'customer is' : 'customers are'} browsing the shop right now`,
      }
      : {
        color: '#94a3b8',
        pulse: false,
        text: '0',
        label: 'No signed-in customers browsing right now',
      },
  }[status];

  return (
    <span className="adm-bridge-dot adm-shoppers-pill" title={meta.label} aria-label={meta.label} role="img">
      <span
        className={`adm-bridge-dot__led${meta.pulse ? ' adm-bridge-dot__led--pulse' : ''}`}
        style={{ background: meta.color, boxShadow: `0 0 0 3px ${meta.color}22` }}
      />
      <span className="adm-shoppers-pill__count">{meta.text}</span>
      <span className="adm-bridge-dot__label">browsing</span>
    </span>
  );
}
