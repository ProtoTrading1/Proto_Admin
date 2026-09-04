import { prepareApolloQuestion } from './apolloConversation';
import { buildBuyerRankingAnswer } from './apolloBuyerRanking';
import { getApolloSource } from '../../lib/apollo-source-catalog.mjs';

const ANALYTICS_FOCUS = new Set(['overview', 'orders', 'customer_attention', 'search', 'baskets', 'catalogue', 'customers', 'crm', 'site_content', 'product_loader', 'fulfillment', 'operations']);
const FOCUS_SECTIONS = Object.freeze({
  overview: 'analytics', orders: 'orders', customer_attention: 'analytics', search: 'analytics',
  baskets: 'analytics', catalogue: 'catalogue', customers: 'customers', crm: 'comms',
  site_content: 'site-content', product_loader: 'product-loader', fulfillment: 'orders', operations: 'backend-health',
});

export function apolloSectionForFocus(focus, sourcePlan = []) {
  return FOCUS_SECTIONS[focus]
    || getApolloSource(sourcePlan.find((id) => getApolloSource(id)?.section))?.section
    || 'analytics';
}

const ANALYSIS_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function savedApolloReference(search) {
  const id = new URLSearchParams(search).get('apolloJob');
  return ANALYSIS_REFERENCE.test(id || '') ? id : null;
}

export function rememberApolloReference(id) {
  if (!ANALYSIS_REFERENCE.test(id || '') || typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  url.searchParams.set('apolloJob', id);
  // Store only an opaque reference, never a question, report or credential.
  // Failure to update browser history must not interrupt an otherwise valid job.
  try { window.history.replaceState(window.history.state, '', url); } catch { return false; }
  return true;
}

export async function readSavedApolloAnswer(jobId, { signal, onProgress } = {}) {
  if (!ANALYSIS_REFERENCE.test(jobId || '')) throw new Error('This saved-answer link is invalid. No new analysis was requested.');
  const report = await waitForApolloJob(jobId, signal, onProgress, { immediate: true });
  return { ...report, type: 'analytics', title: 'Saved Apollo answer', sources: ['Saved analytics report'], section: 'analytics', periodLabel: 'Saved report — original reporting window' };
}

const FOCUS_SOURCES = {
  overview: ['Orders', 'Customer attention', 'Search activity', 'Outstanding baskets'],
  orders: ['Order analytics'],
  customer_attention: ['Active product and category viewing', 'Order analytics'],
  search: ['Website search activity', 'Order attribution'],
  baskets: ['Outstanding baskets', 'Order analytics'],
  catalogue: ['Live catalogue totals'],
  customers: ['Customer-base totals'],
  crm: ['Campaign performance totals'],
  site_content: ['Featured, specials and banner configuration'],
  product_loader: ['Product Loader audit totals'],
  fulfillment: ['Order workflow totals'],
  operations: ['Backend Health', 'Image Processing Centre', 'Approved business totals'],
};

function periodFromQuestion(question) {
  const value = String(question || '').toLowerCase();
  if (/\btoday\b/.test(value)) return { periodDays: 1, periodKey: 'today' };
  if (/\b(24 hours?|one day|1 days?)\b/.test(value)) return { periodDays: 1, periodKey: 'rolling' };
  if (/\bthis week\b/.test(value)) return { periodDays: 7, periodKey: 'week_to_date' };
  if (/\b(week|7 days?)\b/.test(value)) return { periodDays: 7, periodKey: 'rolling' };
  if (/\b(quarter|90 days?|three months?)\b/.test(value)) return { periodDays: 90, periodKey: 'rolling' };
  return { periodDays: 30, periodKey: 'rolling' };
}

export function classifyApolloQuestion(question) {
  const value = String(question || '').toLowerCase();
  const period = periodFromQuestion(value);
  const buyerRanking = /\b(?:who|which\s+(?:customer|company)|top\s+(?:buyer|customer|company)|biggest\s+(?:buyer|customer|company))\b.*\b(?:bought|buy|purchased|ordered|stock|units|items)\b|\b(?:bought|purchased|ordered)\b.*\b(?:most|highest|largest)\b|\bmost\s+(?:stock|units|items)\b/.test(value);
  if (buyerRanking) return { kind: 'buyer_ranking', ...period };
  if (/\b(what can (?:you|apollo) (?:access|see|check)|what do you know|data sources?|capabilities|coverage)\b/.test(value)) return { kind: 'sources', ...period };
  if (/\b(what needs my attention|morning brief|operational brief|what is happening|what's happening)\b/.test(value)) return { kind: 'analytics', focus: 'overview', ...period };
  if (/\b(health|healthy|system|systems|backend|bridge|database|vercel|service|services|offline|down)\b|\b(?:website|portal|site|service|system)\s+(?:is\s+)?online\b|\bonline\s+(?:status|health)\b/.test(value)) return { kind: 'health', ...period };
  if (/\b(publish history|loader audit|published products|product loader)\b/.test(value)) return { kind: 'analytics', focus: 'product_loader', ...period };
  if (/\b(image|images|photo|photos|processing queue|archived image|archived images)\b/.test(value)) return { kind: 'images', ...period };
  if (/\b(featured|specials|banner|site content|homepage|home page)\b/.test(value)) return { kind: 'analytics', focus: 'site_content', ...period };
  if (/\b(campaign|campaigns|email performance|delivered|opened|clicked|bounced|communications|comms)\b/.test(value)) return { kind: 'analytics', focus: 'crm', ...period };
  if (/\b(archive|archived|new image items|recycle bin|approval pending|catalogue|catalog|live products|uncategorized|product count)\b/.test(value)) return { kind: 'analytics', focus: 'catalogue', ...period };
  if (/\b(customer base|account count|how many customers)\b/.test(value)) return { kind: 'analytics', focus: 'customers', ...period };
  if (/\b(fulfillment|fulfilment|handed over|in progress|order sent|payment received|workflow)\b/.test(value)) return { kind: 'analytics', focus: 'fulfillment', ...period };
  if (/\b(search|searches|searched|searching|no results?|zero results?)\b/.test(value)) return { kind: 'analytics', focus: 'search', ...period };
  if (/\b(basket|baskets|abandoned cart|abandoned carts|checkout)\b/.test(value)) return { kind: 'analytics', focus: 'baskets', ...period };
  if (/\b(view|views|viewed|viewing|duration|attention|category|categories|customer interest|customers looking)\b/.test(value)) return { kind: 'analytics', focus: 'customer_attention', ...period };
  if (/\b(order|orders|revenue|sales|average order|repeat customer)\b/.test(value)) return { kind: 'analytics', focus: 'orders', ...period };
  return { kind: 'analytics', focus: 'overview', ...period };
}

function sourceCatalogAnswer(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  const connected = sources.filter((item) => item.status === 'connected');
  const planned = sources.filter((item) => item.status === 'planned');
  return {
    type: 'sources',
    title: 'Apollo source coverage',
    summary: `Apollo can currently check ${connected.length} approved read-only source${connected.length === 1 ? '' : 's'} for your access level. ${planned.length} additional source${planned.length === 1 ? ' is' : 's are'} clearly marked as planned rather than treated as live.`,
    findings: [],
    limitations: planned.map((item) => `${item.label} is planned and not yet connected.`),
    sources: connected.map((item) => item.label),
    section: 'hermes',
    readOnly: true,
  };
}

function unavailableSourceAnswer(source) {
  return {
    type: 'sources',
    title: `${source.label} is not connected yet`,
    summary: `Apollo will not guess about ${source.label.toLowerCase()}. The source is marked as planned and no model request was made.`,
    findings: [],
    limitations: [`${source.label} must be connected to an approved read-only source before Apollo can answer this question.`],
    sources: [source.label],
    section: source.section,
    readOnly: true,
  };
}

async function buyerRankingAnswer(classification, signal) {
  const query = classification.periodKey === 'week_to_date'
    ? 'window=week_to_date'
    : `period=${classification.periodDays}`;
  const payload = await readJson(`/api/apollo-order-leader?${query}`, { signal, cache: 'no-store' });
  return buildBuyerRankingAnswer(payload, classification.periodDays);
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Apollo could not read ${url}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { const error = new Error('Apollo request cancelled'); error.name = 'AbortError'; reject(error); return; }
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = window.setTimeout(finish, ms);
    const cancel = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const error = new Error('Apollo request cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function waitForApolloJob(jobId, signal, onProgress = () => {}, { immediate = false } = {}) {
  if (!jobId) throw new Error('Apollo did not receive an analysis reference. Please try again.');
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (signal?.aborted) { const error = new Error('Apollo request cancelled'); error.name = 'AbortError'; throw error; }
    if (attempt !== 0 || !immediate) await wait(attempt < 30 ? 2000 : 4000, signal);
    const job = await readJson(`/api/codex-analytics-jobs?id=${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' });
    onProgress({ jobId, status: job.status, delayed: attempt >= 10 });
    if (job.status === 'completed') {
      if (!job.result?.summary) throw new Error('Apollo returned an incomplete report. Please check the analysis worker.');
      return job.result;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Apollo analysis failed');
    if (!['queued', 'running', 'processing'].includes(job.status)) throw new Error('Apollo returned an unknown analysis state. Please check the analysis worker.');
  }
  throw new Error('Apollo has not returned an answer yet. Check this request again without submitting another analysis.');
}

function healthAnswer(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  if (!checks.length) throw new Error('No health-check evidence was returned. Apollo cannot confirm that systems are healthy.');
  const concerns = checks.filter((check) => ['critical', 'warning', 'unknown'].includes(check.state));
  return {
    type: 'health', title: 'Proto systems health',
    summary: concerns.length ? `${concerns.length} monitored area${concerns.length === 1 ? '' : 's'} need attention. ${concerns.map((item) => `${item.label}: ${item.summary}`).join(' ')}` : 'All monitored Proto backend systems are healthy.',
    findings: concerns.slice(0, 8).map((item) => ({ severity: item.state === 'critical' ? 'high' : 'medium', title: item.label, explanation: item.summary, recommendedAction: item.action || 'Open Backend Health for the latest technical evidence.', evidence: [item.detail].filter(Boolean) })),
    limitations: [], sources: ['Backend Health'], section: 'backend-health', generatedAt: payload?.generatedAt,
  };
}

function imageAnswer(payload) {
  if (!Array.isArray(payload?.jobs) || payload?.available === false) throw new Error('Image-processing evidence is unavailable. Apollo cannot confirm the queue is empty.');
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const counts = jobs.reduce((result, job) => { const status = String(job?.status || 'unknown').toLowerCase(); result[status] = (result[status] || 0) + 1; return result; }, {});
  const waiting = (counts.queued || 0) + (counts.processing || 0) + (counts.review || 0) + (counts.approved || 0);
  const failed = counts.failed || 0;
  return {
    type: 'images', title: 'Image processing watch',
    summary: `${jobs.length} recent image item${jobs.length === 1 ? '' : 's'} checked. ${waiting} waiting in the workflow and ${failed} failed.`,
    findings: [
      waiting ? { severity: 'medium', title: 'Images waiting for work', explanation: `${waiting} image item${waiting === 1 ? '' : 's'} are queued, processing, in review or approved but not finished.`, recommendedAction: 'Open Image Processing Centre and work from the oldest waiting item.', evidence: [] } : null,
      failed ? { severity: 'high', title: 'Failed image items', explanation: `${failed} image item${failed === 1 ? '' : 's'} need attention.`, recommendedAction: 'Open Image Processing Centre and review the recorded error before retrying.', evidence: [] } : null,
    ].filter(Boolean),
    limitations: [], sources: ['Image Processing Centre'], section: 'image-processing', generatedAt: new Date().toISOString(),
  };
}

async function analyticsAnswer(classification, prepared, signal, onProgress, resumeJobId) {
  const focus = ANALYTICS_FOCUS.has(classification.focus) ? classification.focus : 'overview';
  const request = {
    periodDays: classification.periodDays,
    focus,
    mode: 'read_only',
    question: prepared.question,
    context: prepared.context,
    sourcePlan: prepared.sourcePlan,
  };
  if (classification.periodKey === 'today') request.periodKey = 'today';
  const created = resumeJobId ? { id: resumeJobId, status: 'queued' } : await readJson('/api/codex-analytics-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  onProgress?.({ jobId: created.id || created.jobId, status: created.status || 'queued', delayed: false });
  const report = created.result || await waitForApolloJob(created.id || created.jobId, signal, onProgress);
  const section = apolloSectionForFocus(focus, prepared.sourcePlan);
  return { ...report, type: 'analytics', title: focus === 'overview' ? 'Proto operational brief' : 'Apollo operational answer', sources: FOCUS_SOURCES[focus], section, periodDays: classification.periodDays, periodLabel: classification.periodKey === 'today' ? 'Today' : `${classification.periodDays}-day view` };
}

export async function askApolloOperations(question, { signal, onProgress, resumeJobId, context = [] } = {}) {
  const prepared = prepareApolloQuestion(question, context);
  if (!prepared.ok) {
    return { type: 'clarification', title: 'Apollo needs one detail', summary: prepared.clarification, findings: [], limitations: [], sources: [], sourcePlan: [], readOnly: true };
  }
  const classification = classifyApolloQuestion(question);
  if (classification.kind === 'sources') return { ...sourceCatalogAnswer(await readJson('/api/apollo-source-catalog', { signal, cache: 'no-store' })), sourcePlan: prepared.sourcePlan };
  const plannedOnly = prepared.sourcePlan.length && prepared.sourcePlan.every((id) => getApolloSource(id)?.status === 'planned');
  if (plannedOnly) return { ...unavailableSourceAnswer(getApolloSource(prepared.sourcePlan[0])), sourcePlan: prepared.sourcePlan };
  if (['analytics', 'buyer_ranking'].includes(classification.kind)) {
    const value = String(question || '').toLowerCase();
    const dayWindow = value.match(/\b(\d+)\s+days?\b/);
    const hourWindow = value.match(/\b(\d+)\s+hours?\b/);
    if (/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b|\byesterday\b/.test(value)
      || (dayWindow && ![1, 7, 30, 90].includes(Number(dayWindow[1])))
      || (hourWindow && Number(hourWindow[1]) !== 24)) {
      throw new Error('Apollo cannot query that date range yet. Ask for today, the last 24 hours, 7 days, 30 days or 90 days; no substitute report was requested.');
    }
  }
  if (classification.kind === 'buyer_ranking') return { ...await buyerRankingAnswer(classification, signal), sourcePlan: prepared.sourcePlan };
  if (classification.kind === 'health' && prepared.sourcePlan.length === 1) return { ...healthAnswer(await readJson('/api/backend-health', { signal, cache: 'no-store' })), sourcePlan: prepared.sourcePlan };
  if (classification.kind === 'images' && prepared.sourcePlan.length === 1) return { ...imageAnswer(await readJson('/api/image-processing-jobs', { signal, cache: 'no-store' })), sourcePlan: prepared.sourcePlan };
  return { ...await analyticsAnswer(classification, prepared, signal, onProgress, resumeJobId), sourcePlan: prepared.sourcePlan };
}
