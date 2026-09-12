import { useCallback, useEffect, useRef, useState } from 'react';

const money = value => value === null || value === undefined || !Number.isFinite(Number(value))
  ? 'Unknown' : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(value));
const when = value => value ? new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) : 'Never';
const SOURCES = ['orders', 'searches', 'positill', 'memory', 'activeTime', 'live'];

function mergeSources(previous, next) {
  const merged = { ...next };
  for (const key of SOURCES) {
    if (previous?.[key]?.data != null && next[key]?.status === 'unavailable') {
      merged[key] = { ...previous[key], stale: true, complete: false, reason: next[key].reason };
    }
  }
  return merged;
}

function useFeed(url, interval, refresh, denied, onDenied) {
  const [state, setState] = useState({ url, data: null });
  const started = useRef({ url: '', at: -Infinity });
  useEffect(() => {
    if (denied) { setState({ url, data: null }); return undefined; }
    let disposed = false;
    let controller;
    let timer;
    setState(old => old.url === url ? old : { url, data: null });
    const load = async () => {
      clearTimeout(timer);
      if (disposed || document.visibilityState !== 'visible') return;
      const elapsed = started.current.url === url ? Date.now() - started.current.at : Infinity;
      if (elapsed < interval) { timer = setTimeout(load, interval - elapsed); return; }
      started.current = { url, at: Date.now() };
      controller = new AbortController();
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        if ([401, 403].includes(response.status)) { setState({ url, data: null }); onDenied(); return; }
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Report refresh failed');
        if (!disposed && !controller.signal.aborted) setState(old => ({ url,
          data: mergeSources(old.url === url ? old.data : null, body), stale: false }));
      } catch (err) {
        if (!disposed && !controller.signal.aborted) setState(old => ({ url,
          data: old.url === url ? old.data : null, stale: true, error: err.message }));
      } finally {
        if (!disposed) timer = setTimeout(load, interval);
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') void load();
      else { controller?.abort(); clearTimeout(timer); }
    };
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [url, interval, refresh, denied, onDenied]);
  return denied || state.url !== url ? { data: null } : state;
}

function Evidence({ title, source, children }) {
  return <section className="oa-panel"><h3>{title}</h3>
    <p className="oa-note">Source: {source?.source || 'Not loaded'} · last successful read: {when(source?.lastSuccessfulAt)}</p>
    {source?.stale && <p role="status">Stale: refresh failed. Showing the last successful result.</p>}
    {source?.data == null ? <p>Unavailable — {source?.reason || 'not loaded yet'}.</p> : children}
    {source?.data?.limitations?.map(note => <p className="oa-note" key={note}>{note}</p>)}
  </section>;
}

export default function ApolloBusinessPulse() {
  const [period, setPeriod] = useState('day');
  const [dates, setDates] = useState({ start: '', end: '' });
  const [refresh, setRefresh] = useState(0);
  const [denied, setDenied] = useState(false);
  const onDenied = useCallback(() => setDenied(true), []);
  const params = new URLSearchParams({ period, ...(period === 'custom' ? dates : {}) });
  const summary = useFeed(`/api/apollo-pulse?${params}`, 300000, refresh, denied, onDenied);
  const live = useFeed('/api/apollo-pulse?view=live', 60000, refresh, denied, onDenied);
  const data = summary.data;
  if (denied) return <p role="alert">Owner access is required. Sign in again to load Apollo.</p>;
  return <section aria-labelledby="apollo-title">
    <h2 id="apollo-title">Apollo Business Pulse</h2>
    <p>Read-only preview. Website order value is not Positill sales. All times are South African.</p>
    <div className="oa-toolbar">
      <label>Period <select value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="day">Today</option><option value="week">This week</option><option value="month">This month</option><option value="custom">Custom</option>
      </select></label>
      {period === 'custom' && <><label>Start <input type="date" value={dates.start} onChange={event => setDates({ ...dates, start: event.target.value })} /></label>
        <label>End <input type="date" value={dates.end} onChange={event => setDates({ ...dates, end: event.target.value })} /></label></>}
      <button type="button" onClick={() => setRefresh(n => n + 1)}>Refresh when due</button>
    </div>
    <p className="oa-note">Live activity refreshes once a minute; reports every five minutes while visible. Custom ranges: up to 366 days.</p>
    {summary.error && <p role="alert">{summary.error}</p>}
    {summary.stale && data && <p role="status">Report refresh failed. The previous result for this period is shown.</p>}
    <Evidence title="Website orders" source={data?.orders}>
      <p>{data?.orders?.data?.orders} recorded orders · {money(data?.orders?.data?.revenue)} order value incl. VAT (cancelled orders excluded from value).</p>
      {data?.orders?.data?.productsComplete === false && <p role="status">Product rankings are incomplete: some recorded lines lack usable identifiers or quantities.</p>}
      <h4>Top products by recorded units</h4>
      {data?.orders?.data?.products?.slice(0, 10).map(p => <p key={p.key}>{p.key} · {p.units} units · {money(p.value)} line value</p>)}
    </Evidence>
    <Evidence title="Searches" source={data?.searches}>
      <p>{data?.searches?.data?.recordedSearches} recorded searches</p>
      {data?.searches?.data?.topTerms?.map(term => <p key={term.term}>{term.term} · {term.searches} searches · {term.zeroResults} with no results</p>)}
    </Evidence>
    <Evidence title="Positill sales" source={data?.positill} />
    <Evidence title="Approved memory" source={data?.memory} />
    <Evidence title="Active browsing time" source={data?.activeTime} />
    {live.stale && <p role="status">Live refresh failed. Customers below were active at the last successful read, not necessarily now.</p>}
    <Evidence title="Recently active customers" source={live.data?.live}>
      <p>{live.data?.live?.data?.count} signed-in customers active within {live.data?.live?.data?.freshnessSeconds} seconds of the successful read.</p>
      {live.data?.live?.data?.customers?.map(customer => <details key={customer.customerId}>
        <summary>{customer.name} · last seen {when(customer.lastSeenAt)} · basket {customer.basketState === 'not_recorded' ? 'not recorded' : customer.basketState}</summary>
        {customer.basket && <><p>{money(customer.basket.value)} incl. VAT · {customer.basket.totalQty} units</p>
          {customer.basket.items.map((item, index) => <p key={`${item.sku}-${index}`}>{item.name} ({item.sku}) · {item.qty} × {money(item.price)}</p>)}</>}
      </details>)}
    </Evidence>
  </section>;
}
