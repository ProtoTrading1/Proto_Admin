import { useCallback, useEffect, useRef, useState } from 'react';
import { answerApolloQuestion } from '../../lib/apollo-qa.mjs';
import './ApolloBusinessPulse.css';

const money = value => value === null || value === undefined || !Number.isFinite(Number(value))
  ? 'Unknown' : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(value));
const when = value => value ? new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) : 'Never';
const sectionLabel = value => ({ home: 'Home', main: 'Main website', instore: 'Instore products', checkout: 'Checkout', account: 'Account', other: 'Other' })[value] || 'not collected yet';
const duration = value => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unknown';
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};
const SOURCES = ['orders', 'searches', 'positill', 'memory', 'activeTime', 'baskets', 'live'];
const INSIGHT_LABELS = { opportunity: 'Opportunity', conversion: 'Conversion', orders: 'Order flow', engagement: 'Engagement', basket: 'Basket risk' };
const EMPTY_MEMORY_FORM = { key: '', kind: 'definition', title: '', body: '', evidenceRefs: '', state: 'draft', expectedVersion: 0 };
const QUICK_QUESTIONS = [
  'Who is online now?',
  'What are the best sellers today?',
  'What are customers searching for?',
  'Which searches found no results?',
];
const SAVED_VIEWS = [
  { key: 'today', label: 'Today', period: 'day', question: 'Who is online now?' },
  { key: 'week', label: 'This week', period: 'week', question: 'What are customers searching for?' },
  { key: 'instore', label: 'Instore demand', period: 'week', question: 'What are the Instore searches this week?' },
  { key: 'reconciliation', label: 'Sales reconciliation', period: 'month', question: 'What Positill data is available this month?' },
];

function latestMemoryRevisions(records = []) {
  const latest = new Map();
  for (const record of records) {
    if (!latest.has(record.key) || record.version > latest.get(record.key).version) latest.set(record.key, record);
  }
  return [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
}

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
          data: mergeSources(old.url === url ? old.data : null, body), stale: false, refreshedAt: new Date().toISOString() }));
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
    {source?.status === 'partial' && <p role="status">Partial data only. Totals are not verified as complete for this period.</p>}
    {source?.data == null ? <p>Unavailable — {source?.reason || 'not loaded yet'}.</p> : children}
    {source?.data?.limitations?.map(note => <p className="oa-note" key={note}>{note}</p>)}
  </section>;
}

function SourceState({ source }) {
  const state = source?.stale ? 'stale' : source?.status || 'unavailable';
  const label = state === 'available' ? 'Verified' : state === 'partial' ? 'Partial' : state === 'stale' ? 'Stale' : 'Unavailable';
  return <span className={`oa-source-state oa-source-state--${state}`}>{label}</span>;
}

function DataConfidence({ report, liveReport }) {
  const sources = [
    ['Website orders', report?.orders], ['Searches', report?.searches], ['Baskets', report?.baskets],
    ['Live customers', liveReport?.live], ['Positill', report?.positill],
  ];
  return <section className="oa-confidence oa-panel" aria-labelledby="apollo-confidence-title">
    <div className="oa-section-heading"><div><p className="oa-eyebrow">REPORTING QUALITY</p><h3 id="apollo-confidence-title">Data confidence</h3></div></div>
    <p className="oa-note">Apollo never turns an unavailable feed into a zero. Each source below is shown with its current reporting state.</p>
    <div className="oa-confidence-grid">{sources.map(([label, source]) => <div className="oa-confidence-item" key={label}>
      <span>{label}</span><SourceState source={source} />
      <small>{source?.lastSuccessfulAt ? `Updated ${when(source.lastSuccessfulAt)}` : source?.reason || 'Waiting for a successful read'}</small>
    </div>)}</div>
  </section>;
}

function ActionQueue({ report, onAsk }) {
  const zeroResults = Number(report?.searches?.data?.comparison?.metrics?.zeroResultSearches?.current ?? report?.searches?.data?.topTerms?.reduce((total, term) => total + Number(term.zeroResults || 0), 0) ?? 0);
  const coldBaskets = Number(report?.baskets?.data?.coldBaskets || 0);
  const actions = [
    zeroResults > 0 && { title: `${zeroResults} no-result search${zeroResults === 1 ? '' : 'es'}`, detail: 'Review catalogue wording, synonyms or buying opportunity. No customer is contacted automatically.', question: 'Which searches found no results?' },
    coldBaskets > 0 && { title: `${coldBaskets} inactive basket${coldBaskets === 1 ? '' : 's'}`, detail: 'Review basket context before deciding on any manual follow-up.', question: 'What baskets need attention?' },
    report?.positill?.status !== 'available' && { title: 'Positill sales need verification', detail: 'Keep website order value separate until dated Positill invoice reporting is connected and reconciled.', question: 'What Positill data is available this month?' },
  ].filter(Boolean);
  return <section className="oa-action-queue oa-panel" aria-labelledby="apollo-actions-title">
    <div className="oa-section-heading"><div><p className="oa-eyebrow">OWNER REVIEW</p><h3 id="apollo-actions-title">Action queue</h3></div><span className="oa-queue-count">{actions.length}</span></div>
    <p className="oa-note">Suggestions only. Apollo cannot send messages, change orders, prices or stock.</p>
    {actions.length ? actions.map(action => <article className="oa-action" key={action.title}><div><strong>{action.title}</strong><p>{action.detail}</p></div><button type="button" onClick={() => onAsk(action.question)}>Review</button></article>)
      : <p>No verified owner action needs attention for this period.</p>}
  </section>;
}

function Comparison({ comparison, metrics }) {
  if (!comparison) return null;
  if (comparison.status !== 'available') return <p className="oa-note" role="status">Previous-period comparison unavailable — {comparison.reason || 'both periods need complete data'}.</p>;
  const range = comparison.window;
  const date = value => new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium' }).format(new Date(value));
  const deltaText = (value, format) => value === 0 ? `no change (${format(value)})` : `${value > 0 ? '+' : ''}${format(value)}`;
  const percentText = value => value === null ? 'percentage change unavailable from a zero baseline' : `${value > 0 ? '+' : ''}${value}%`;
  return <div className="oa-note" aria-label="Previous-period comparison">
    <p>Compared with {date(range.start)}–{date(Date.parse(range.end) - 1000)}{range.comparisonBasis === 'matching_period_to_date' ? ' at the same elapsed point in the previous period' : ''}:</p>
    {metrics.map(({ key, label, format }) => {
      const metric = comparison.metrics?.[key];
      if (!metric || metric.status !== 'available') return <p key={key}>{label}: comparison unavailable.</p>;
      return <p key={key}>{label}: {format(metric.current)} vs {format(metric.previous)} ({deltaText(metric.delta, format)}; {percentText(metric.percentChange)}).</p>;
    })}
  </div>;
}

export default function ApolloBusinessPulse() {
  const [period, setPeriod] = useState('day');
  const [dates, setDates] = useState({ start: '', end: '' });
  const [refresh, setRefresh] = useState(0);
  const [denied, setDenied] = useState(false);
  const [memoryPage, setMemoryPage] = useState({ records: [], nextCursor: null, loading: false, error: '' });
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [memoryForm, setMemoryForm] = useState(EMPTY_MEMORY_FORM);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState('');
  const memoryFormRef = useRef(null);
  const memoryTitleRef = useRef(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const onDenied = useCallback(() => setDenied(true), []);
  const params = new URLSearchParams({ period, ...(period === 'custom' ? dates : {}) });
  const summary = useFeed(`/api/apollo-pulse?${params}`, 300000, refresh, denied, onDenied);
  const live = useFeed('/api/apollo-pulse?view=live', 60000, refresh, denied, onDenied);
  const memoryFeed = useFeed('/api/apollo-memory?view=manage&limit=50', 300000, memoryRefresh, denied, onDenied);
  useEffect(() => {
    if (memoryFeed.data) setMemoryPage({ records: memoryFeed.data.revisions || memoryFeed.data.memories || [], nextCursor: memoryFeed.data.nextCursor || null, loading: false, error: '' });
  }, [memoryFeed.data]);
  const loadMoreMemory = useCallback(async () => {
    if (!memoryPage.nextCursor || memoryPage.loading) return;
    setMemoryPage(current => ({ ...current, loading: true, error: '' }));
    try {
      const query = new URLSearchParams({ view: 'manage', limit: '50', cursor: memoryPage.nextCursor });
      const response = await fetch(`/api/apollo-memory?${query}`);
      if ([401, 403].includes(response.status)) { onDenied(); return; }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Memory page unavailable');
      setMemoryPage(current => ({ records: [...current.records, ...(body.revisions || body.memories || [])], nextCursor: body.nextCursor || null, loading: false, error: '' }));
    } catch { setMemoryPage(current => ({ ...current, loading: false, error: 'More approved memory could not be loaded.' })); }
  }, [memoryPage.nextCursor, memoryPage.loading, onDenied]);
  const saveMemory = async event => {
    event.preventDefault();
    setMemorySaving(true); setMemoryNotice('');
    const payload = {
      key: memoryForm.key.trim(), kind: memoryForm.kind, title: memoryForm.title.trim(), body: memoryForm.body.trim(),
      evidenceRefs: memoryForm.evidenceRefs.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      state: memoryForm.state, expectedVersion: memoryForm.expectedVersion,
    };
    try {
      const response = await fetch('/api/apollo-memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if ([401, 403].includes(response.status)) { onDenied(); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Memory could not be saved');
      setMemoryForm(EMPTY_MEMORY_FORM); setMemoryNotice('Revision saved. Only revisions saved as approved are eligible for Apollo answers.');
      setMemoryRefresh(value => value + 1);
    } catch (error) {
      setMemoryNotice(error.message === 'Memory could not be saved'
        ? 'Could not save. The key may have changed; refresh memory and retry, or check the required evidence fields.'
        : error.message || 'Memory could not be saved.');
    } finally { setMemorySaving(false); }
  };
  const reviseMemory = record => {
    setMemoryForm({ key: record.key, kind: record.kind, title: record.title, body: record.body,
      evidenceRefs: (record.evidenceRefs || []).join('\n'), state: 'draft', expectedVersion: record.version });
    setMemoryNotice('Editing the latest revision. Choose Draft to propose it, or explicitly approve it when reviewed.');
    requestAnimationFrame(() => {
      memoryFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      memoryTitleRef.current?.focus({ preventScroll: true });
    });
  };
  const changeMemoryKey = value => {
    const existing = latestMemoryRevisions(memoryPage.records).find(record => record.key === value.trim());
    setMemoryForm(current => ({ ...current, key: value, expectedVersion: existing?.version || 0 }));
  };
  const data = summary.data;
  const askQuestion = value => {
    const nextQuestion = String(value || '').trim();
    if (!nextQuestion) return;
    setQuestion(nextQuestion);
    setAnswer(answerApolloQuestion(nextQuestion, {
      report: data ? { ...data, stale: summary.stale } : null,
      liveReport: live.data ? { ...live.data, stale: live.stale } : null,
      selectedPeriod: period,
    }));
  };
  const askApollo = event => { event.preventDefault(); askQuestion(question); };
  const selectSavedView = view => {
    setPeriod(view.period);
    askQuestion(view.question);
  };
  const memorySource = memoryFeed.data ? {
    source: 'Apollo memory revision database', status: 'available', lastSuccessfulAt: memoryFeed.refreshedAt,
    stale: memoryFeed.stale, data: { records: memoryFeed.data.memories || [], limitations: ['Only approved revisions are eligible for answers; changing sales facts remain in live reports.'] },
  } : { source: 'Apollo memory revision database', status: 'unavailable', data: null, reason: memoryFeed.error || 'Memory is disabled or not configured.' };
  if (denied) return <p role="alert">Owner access is required. Sign in again to load Apollo.</p>;
  return <section className="apollo-pulse" aria-labelledby="apollo-title">
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
    <nav className="oa-saved-views" aria-label="Saved Apollo views">
      {SAVED_VIEWS.map(view => <button type="button" key={view.key} className={period === view.period ? 'is-selected' : ''} onClick={() => selectSavedView(view)}>{view.label}</button>)}
    </nav>
    <section className="oa-today" aria-labelledby="apollo-today-title">
      <div className="oa-section-heading">
        <div><p className="oa-eyebrow">OPERATING NOW</p><h3 id="apollo-today-title">Today at a glance</h3></div>
        <SourceState source={summary.stale ? { stale: true } : data?.orders} />
      </div>
      <div className="oa-metric-grid">
        <button type="button" className="oa-metric" onClick={() => askQuestion('Who is online now?')}>
          <span>Online now</span><strong>{live.data?.live?.data?.count ?? '—'}</strong><small>signed-in customers · <SourceState source={live.data?.live} /></small>
        </button>
        <button type="button" className="oa-metric" onClick={() => askQuestion('What baskets need attention?')}>
          <span>Open baskets</span><strong>{data?.baskets?.data?.openBaskets ?? '—'}</strong><small>{money(data?.baskets?.data?.valueInclVat)} snapshot value</small>
        </button>
        <button type="button" className="oa-metric" onClick={() => askQuestion('What is the website order value today?')}>
          <span>Website orders</span><strong>{money(data?.orders?.data?.revenue)}</strong><small>{data?.orders?.data?.orders ?? '—'} recorded · not Positill sales</small>
        </button>
        <button type="button" className="oa-metric" onClick={() => askQuestion('What are customers searching for?')}>
          <span>Search demand</span><strong>{data?.searches?.data?.recordedSearches ?? '—'}</strong><small>{data?.searches?.data?.zeroResultSearches ?? '—'} no-result searches</small>
        </button>
      </div>
      <p className="oa-note">Select a card to see the supporting report. Every total below retains its source, period and freshness.</p>
    </section>
    <div className="oa-operating-grid">
      <DataConfidence report={data} liveReport={live.data} />
      <ActionQueue report={data} onAsk={askQuestion} />
    </div>
    <section className="oa-panel" aria-labelledby="apollo-ask-title">
      <h3 id="apollo-ask-title">Ask Apollo</h3>
      <p className="oa-note">Answers use the owner-only reports shown below for the selected period. Questions are processed in this page and are not saved or sent to an AI provider.</p>
      <form onSubmit={askApollo}>
        <label htmlFor="apollo-question">Ask about online customers, baskets, searches, product interest, website orders, or Positill</label>
        <div className="oa-toolbar">
          <input id="apollo-question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={240} placeholder="e.g. What were the most popular searches?" />
          <button type="submit" disabled={!question.trim()}>Ask</button>
        </div>
      </form>
      <div className="oa-quick-questions" aria-label="Suggested Apollo questions">
        {QUICK_QUESTIONS.map(item => <button type="button" key={item} onClick={() => askQuestion(item)}>{item}</button>)}
      </div>
      {answer && <div role="status" aria-live="polite" className="oa-insight-card">
        <strong>{answer.status === 'answered' ? 'Apollo answer' : answer.status === 'needs_period' ? 'Change the period' : answer.status === 'partial' ? 'Partial evidence' : 'Unavailable / unsupported'}</strong>
        <p>{answer.answer}</p>
        {answer.source && <p className="oa-note">Source: {answer.source}</p>}
        {answer.period && <p className="oa-note">Period: {answer.period}</p>}
        {answer.lastSuccessfulAt && <p className="oa-note">Last successful read: {when(answer.lastSuccessfulAt)}</p>}
      </div>}
    </section>
    <section className="oa-panel" aria-label="Apollo priorities">
      <h3>Apollo priorities</h3>
      <p className="oa-note">A joined business view built from the reporting sources below. It does not replace their detailed Analytics pages.</p>
      {!data?.insights?.length && <p>{data
        ? 'No verified decision insight is available for this period. Review each source’s availability and completeness below.'
        : 'A verified report has not loaded for this period yet.'}</p>}
      {data?.insights?.map((insight, index) => <div key={`${insight.kind}-${index}`} className="oa-insight-card">
        <strong>{INSIGHT_LABELS[insight.kind] || 'Insight'} · {insight.title}</strong>
        <p>{insight.detail}</p>
        <p className="oa-note">Evidence: {insight.source}</p>
      </div>)}
    </section>
    <Evidence title="Website orders" source={data?.orders}>
      <p>{data?.orders?.data?.orders} recorded orders · {money(data?.orders?.data?.revenue)} order value incl. VAT (cancelled orders excluded from value).</p>
      <p className="oa-note">This value includes all non-cancelled order stages; it is not payment-confirmed sales. Positill invoiced sales are reported separately.</p>
      <p className="oa-note">Order statuses: {Object.entries(data?.orders?.data?.statuses || {}).map(([status, count]) => `${status} ${count}`).join(' · ') || 'unavailable'}.</p>
      {data?.orders?.data?.revenueKnown === true && data?.orders?.data?.discountsInclVat > 0 &&
        <p className="oa-note">Recorded promo discounts of {money(data.orders.data.discountsInclVat)} are included in the customer-facing order value.</p>}
      <Comparison comparison={data?.orders?.data?.comparison} metrics={[
        { key: 'orderCount', label: 'Recorded orders', format: value => new Intl.NumberFormat('en-ZA').format(value) },
        { key: 'revenue', label: 'Website order value', format: money },
      ]} />
      {data?.orders?.data?.productsComplete === false && <p role="status">Product rankings are incomplete: some recorded lines lack usable identifiers or quantities.</p>}
      <h4>Top products by recorded units</h4>
      {data?.orders?.data?.products?.slice(0, 10).map(p => <p key={p.key}>{p.key} · {p.units} units · {money(p.value)} line value</p>)}
    </Evidence>
    <Evidence title="Searches" source={data?.searches}>
      <p className="oa-note">Legacy Analytics records do not identify Main versus Instore. See the source-separated event report below; the two feeds are not merged.</p>
      <p>{data?.searches?.data?.recordedSearches} recorded searches</p>
      <Comparison comparison={data?.searches?.data?.comparison} metrics={[
        { key: 'searches', label: 'Recorded searches', format: value => new Intl.NumberFormat('en-ZA').format(value) },
        { key: 'zeroResultSearches', label: 'No-result searches', format: value => new Intl.NumberFormat('en-ZA').format(value) },
      ]} />
      {data?.searches?.data?.topTerms?.map(term => <p key={term.term}>{term.term} · {term.searches} searches · {term.zeroResults} with no results</p>)}
    </Evidence>
    <Evidence title="Main and Instore search activity" source={data?.searchActivity}>
      <p className="oa-note">Follow-on views and basket additions use the most recent completed search in the same signed-in session and surface; association does not prove causation.</p>
      {Object.entries(data?.searchActivity?.data?.surfaces || {}).map(([surface, report]) => <section key={surface}>
        <h4>{surface === 'main' ? 'Main website' : 'Instore products'} · {report.coverage} coverage</h4>
        <p>{report.recordedSearches} completed searches · {report.zeroResultSearches} with no results · {report.productViewsAfterSearch} following product views · {report.basketAddEventsAfterSearch} following basket additions.</p>
        <h5>Popular normalized searches</h5>
        {report.topTerms.map(term => <p key={term.term}>{term.term} · {term.searches} searches · {term.zeroResults} with no results · {term.productViewsAfterSearch} following views · {term.basketAddEventsAfterSearch} following basket additions. Original wording: {term.originals.map(item => item.term).join(', ')}</p>)}
        <h5>Viewed products</h5>
        {report.topProducts.map(product => <p key={product.product}>{product.product} · {product.views} deliberate views</p>)}
        <h5>Viewed categories</h5>
        {report.topCategories.map(category => <p key={category.category}>{category.category} · {category.views} views</p>)}
      </section>)}
      {data?.searchActivity?.data?.limitations?.map(note => <p role="status" key={note}>{note}</p>)}
    </Evidence>
    <Evidence title="Positill report evidence (not verified sales)" source={data?.positill} />
    <Evidence title="Business memory and revision history" source={memorySource}>
      {!memorySource.data?.records?.length && <p>No currently approved memory records.</p>}
      {latestMemoryRevisions(memoryPage.records).map(record => <article key={`${record.key}-${record.version}`} className="oa-insight-card">
        <strong>{record.title}</strong>
        <p>{record.body}</p>
        <p className="oa-note">{record.kind} · version {record.version} · {record.state} · reviewed by {record.reviewer || 'recorded reviewer'}</p>
        {record.evidenceRefs?.length > 0 && <p className="oa-note">Evidence: {record.evidenceRefs.join(', ')}</p>}
        <button type="button" className="adm-btn-ghost" onClick={() => reviseMemory(record)}>Create next revision</button>
      </article>)}
      {memoryPage.error && <p role="alert">{memoryPage.error}</p>}
      {memoryPage.nextCursor && <button type="button" onClick={loadMoreMemory} disabled={memoryPage.loading}>{memoryPage.loading ? 'Loading…' : 'Load more memory records'}</button>}
      <form ref={memoryFormRef} onSubmit={saveMemory} className="oa-panel" aria-label="Author Apollo memory" style={{ marginTop: 14 }}>
        <h4>Record a business definition or decision</h4>
        <p className="oa-note">Memory is versioned and owner-only. Evidence is required. Saving does not change live sales facts or approve a draft automatically.</p>
        <div className="oa-toolbar">
          <label>Stable key <input className="adm-input" required pattern="[a-z0-9][a-z0-9._-]{0,119}" value={memoryForm.key} onChange={event => changeMemoryKey(event.target.value)} placeholder="e.g. sales.vat-basis" /></label>
          <label>Type <select value={memoryForm.kind} onChange={event => setMemoryForm(current => ({ ...current, kind: event.target.value }))}><option value="definition">Definition</option><option value="decision">Decision</option></select></label>
          <label>Review state <select value={memoryForm.state} onChange={event => setMemoryForm(current => ({ ...current, state: event.target.value }))}><option value="draft">Draft</option><option value="approved">Approve this revision</option><option value="superseded">Superseded</option><option value="rejected">Rejected</option></select></label>
        </div>
        <label>Title <input ref={memoryTitleRef} className="adm-input" required maxLength={240} value={memoryForm.title} onChange={event => setMemoryForm(current => ({ ...current, title: event.target.value }))} /></label>
        <label>Definition / decision <textarea className="adm-input" required maxLength={10000} rows={4} value={memoryForm.body} onChange={event => setMemoryForm(current => ({ ...current, body: event.target.value }))} /></label>
        <label>Evidence references (one per line) <textarea className="adm-input" required maxLength={10000} rows={3} value={memoryForm.evidenceRefs} onChange={event => setMemoryForm(current => ({ ...current, evidenceRefs: event.target.value }))} placeholder="Report, policy, or decision record" /></label>
        <p className="oa-note">Expected current version: {memoryForm.expectedVersion}. Existing records create a new revision; they are never overwritten.</p>
        <button type="submit" className="adm-btn-red" disabled={memorySaving}>{memorySaving ? 'Saving…' : 'Save versioned revision'}</button>
        {memoryNotice && <p role="status" aria-live="polite">{memoryNotice}</p>}
      </form>
    </Evidence>
    <Evidence title="Active browsing time" source={data?.activeTime}>
      {data?.activeTime?.status === 'available'
        ? <><p>{duration(data?.activeTime?.data?.activeSeconds)} estimated from visible, interacted intervals across {data?.activeTime?.data?.activeCustomers} signed-in customers.</p>
          <p>Average engaged time per customer: {duration(data?.activeTime?.data?.averageSecondsPerCustomer)}.</p></>
        : <p>Unavailable as a period total until both source collectors confirm continuous coverage. Partial event counts and coverage status are shown below.</p>}
      {data?.activeTime?.data?.eventsRead != null && <p>{data.activeTime.data.eventsRead} activity events read · duplicate records: {data.activeTime.data.duplicateRecords}.</p>}
      {data?.activeTime?.data?.sources && Object.entries(data.activeTime.data.sources).map(([name, state]) => <p className="oa-note" key={name}>{name}: {state.status} · last successful update {when(state.lastSuccessfulAt)}</p>)}
    </Evidence>
    <Evidence title="Outstanding baskets" source={data?.baskets}>
      <p>{data?.baskets?.data?.openBaskets} saved baskets · {data?.baskets?.data?.totalUnits} units · {money(data?.baskets?.data?.valueInclVat)} incl. VAT snapshot value.</p>
      <p>{data?.baskets?.data?.coldBaskets} inactive for more than 30 days. Baskets are not sales.</p>
    </Evidence>
    {live.stale && <p role="status">Live refresh failed. Customers below were active at the last successful read, not necessarily now.</p>}
    <Evidence title="Recently active customers" source={live.data?.live}>
      <p>{live.data?.live?.data?.count} signed-in customers active within {live.data?.live?.data?.freshnessSeconds} seconds of the successful read.</p>
      {live.data?.live?.data?.customers?.map(customer => <details key={customer.customerId}>
        <summary>{customer.name} · last seen {when(customer.lastSeenAt)} · basket {customer.basketState === 'not_recorded' ? 'not recorded' : customer.basketState}</summary>
        <p>Current section: {sectionLabel(customer.currentSection)}.</p>
        {customer.basket && <><p>{money(customer.basket.value)} incl. VAT · {customer.basket.totalQty} units</p>
          {customer.basket.items.map((item, index) => <p key={`${item.sku}-${index}`}>{item.name} ({item.sku}) · {item.qty} × {money(item.price)}</p>)}</>}
      </details>)}
    </Evidence>
  </section>;
}
