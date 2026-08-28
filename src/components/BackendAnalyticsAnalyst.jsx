import { useState } from 'react';
import { Bot, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

const PERIODS = [7, 30, 90];
const ATTENTION_RANGE = { 7: 'week', 30: 'month', 90: 'quarter' };

async function readJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Could not load ${url}`);
  return data;
}

function analystSnapshot(periodDays, attention, orders, search, baskets) {
  return {
    periodDays,
    attention: {
      available: attention.available,
      totalActiveSeconds: attention.totalActiveSeconds,
      products: attention.products,
      categories: attention.categories,
    },
    orders: {
      summary: orders.summary,
      topProducts: orders.topOrderedProducts,
      topCategories: orders.topOrderedCategories,
    },
    search: {
      kpis: search.kpis,
      zeroResultTerms: search.zeroResultTerms,
    },
    baskets: baskets.summary,
  };
}

async function waitForJob(jobId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    const job = await readJson(`/api/codex-analytics-jobs?id=${encodeURIComponent(jobId)}`);
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Codex analysis failed');
  }
  throw new Error('Codex is taking longer than expected. You can run the report again shortly.');
}

const severityLabel = { high: 'Priority', medium: 'Review', low: 'Note' };

export default function BackendAnalyticsAnalyst() {
  const [period, setPeriod] = useState(30);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const analyse = async () => {
    setLoading(true);
    setError('');
    try {
      const [attention, orders, search, baskets] = await Promise.all([
        readJson(`/api/customer-attention?range=${ATTENTION_RANGE[period]}`),
        readJson(`/api/order-analytics?period=${period}`),
        readJson(`/api/search-analytics-dashboard?period=${period}`),
        readJson('/api/abandoned-baskets'),
      ]);
      const response = await fetch('/api/codex-analytics-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: analystSnapshot(period, attention, orders, search, baskets) }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) throw new Error(json.error || 'The backend analyst could not run');
      const jobId = json.id || json.jobId;
      if (!jobId) throw new Error('The Codex analytics job was not created');
      setReport(await waitForJob(jobId));
    } catch (analyseError) {
      setError(analyseError.message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="oa-dashboard">
      <div className="oa-toolbar">
        <div className="oa-periods">{PERIODS.map((days) => (
          <button key={days} type="button" className={`oa-period-btn${period === days ? ' oa-period-btn--active' : ''}`} onClick={() => setPeriod(days)}>{days} days</button>
        ))}</div>
        <button type="button" className="adm-btn-primary" onClick={() => void analyse()} disabled={loading}>
          {loading ? <Loader2 size={15} className="spin" /> : report ? <RefreshCw size={15} /> : <Bot size={15} />}
          {report ? 'Run again' : 'Analyse now'}
        </button>
      </div>

      <section className="oa-panel">
        <div className="oa-panel-head"><div><h3><Bot size={16} /> Backend Analyst</h3><p className="oa-note">Combines orders, searches, outstanding baskets and active product/category viewing into one practical review.</p></div></div>
        <p className="oa-note"><ShieldCheck size={14} /> Codex CLI runs on Hermes in read-only mode. It cannot change products, prices, orders, customers or the live website. Customer names and contact details are excluded.</p>
      </section>

      {error && <div className="oa-error">{error}</div>}
      {!report && !loading && <div className="oa-empty">Choose a period and select <strong>Analyse now</strong>. Nothing runs automatically.</div>}
      {report && <>
        <section className="oa-panel"><div className="oa-panel-head"><h3>Codex summary</h3></div><p>{report.summary}</p></section>
        <div className="oa-split">{report.findings.map((item) => (
          <section className="oa-panel" key={`${item.severity}-${item.title}`}>
            <div className="oa-panel-head"><div><span className={`oa-status oa-status--${item.severity}`}>{severityLabel[item.severity] || 'Review'}</span><h3>{item.title}</h3></div></div>
            <p>{item.explanation}</p>
            <p><strong>Recommended:</strong> {item.recommendedAction}</p>
            {!!item.evidence?.length && <ul>{item.evidence.map((line) => <li key={line}>{line}</li>)}</ul>}
          </section>
        ))}</div>
        {!report.findings.length && <div className="oa-empty">No threshold-based concern was found for this period.</div>}
        {!!report.limitations?.length && <section className="oa-panel"><div className="oa-panel-head"><h3>Data limitations</h3></div><ul>{report.limitations.map((line) => <li key={line}>{line}</li>)}</ul></section>}
      </>}
    </div>
  );
}
