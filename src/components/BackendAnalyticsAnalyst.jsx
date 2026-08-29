import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

const PERIODS = [7, 30, 90];
const PENDING_JOB_KEY = 'proto_pending_codex_analytics_job';

async function readJson(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Could not load ${url}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      const error = new Error('Polling cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

export async function waitForJob(jobId, signal) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    await delay(attempt < 30 ? 2000 : 4000, signal);
    let job;
    try {
      job = await readJson(`/api/codex-analytics-jobs?id=${encodeURIComponent(jobId)}`, { signal });
    } catch (error) {
      if (error.status === 400 || error.status === 404) window.localStorage.removeItem(PENDING_JOB_KEY);
      throw error;
    }
    if (job.status === 'completed') {
      window.localStorage.removeItem(PENDING_JOB_KEY);
      return job.result;
    }
    if (job.status === 'failed') {
      window.localStorage.removeItem(PENDING_JOB_KEY);
      throw new Error(job.error || 'Codex analysis failed');
    }
  }
  throw new Error('Codex is taking longer than expected. You can run the report again shortly.');
}

const severityLabel = { high: 'Priority', medium: 'Review', low: 'Note' };

export default function BackendAnalyticsAnalyst() {
  const [period, setPeriod] = useState(30);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pollController = useRef(null);

  useEffect(() => {
    let cancelled = false;
    try {
      const pending = JSON.parse(window.localStorage.getItem(PENDING_JOB_KEY) || 'null');
      if (!pending?.id) return undefined;
      const controller = new AbortController();
      pollController.current = controller;
      setLoading(true);
      if (PERIODS.includes(Number(pending.period))) setPeriod(Number(pending.period));
      waitForJob(pending.id, controller.signal).then((result) => {
        if (!cancelled) setReport(result);
      }).catch((resumeError) => {
        if (!cancelled && resumeError.name !== 'AbortError') setError(resumeError.message);
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    } catch {
      window.localStorage.removeItem(PENDING_JOB_KEY);
    }
    return () => {
      cancelled = true;
      pollController.current?.abort();
    };
  }, []);

  const analyse = async () => {
    setLoading(true);
    setError('');
    try {
      pollController.current?.abort();
      const controller = new AbortController();
      pollController.current = controller;
      const response = await fetch('/api/codex-analytics-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodDays: period }),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) throw new Error(json.error || 'The backend analyst could not run');
      const jobId = json.id || json.jobId;
      if (!jobId) throw new Error('The Codex analytics job was not created');
      window.localStorage.setItem(PENDING_JOB_KEY, JSON.stringify({ id: jobId, period }));
      setReport(await waitForJob(jobId, controller.signal));
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
