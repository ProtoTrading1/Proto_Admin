const ANALYTICS_FOCUS = new Set(['overview', 'orders', 'customer_attention', 'search', 'baskets']);

const FOCUS_SOURCES = {
  overview: ['Orders', 'Customer attention', 'Search activity', 'Outstanding baskets'],
  orders: ['Order analytics'],
  customer_attention: ['Active product and category viewing', 'Order analytics'],
  search: ['Website search activity', 'Order attribution'],
  baskets: ['Outstanding baskets', 'Order analytics'],
};

function periodFromQuestion(question) {
  const value = String(question || '').toLowerCase();
  if (/\btoday\b/.test(value)) return { periodDays: 1, periodKey: 'today' };
  if (/\b(24 hours?|one day)\b/.test(value)) return { periodDays: 1, periodKey: 'rolling' };
  if (/\b(week|7 days?)\b/.test(value)) return { periodDays: 7, periodKey: 'rolling' };
  if (/\b(quarter|90 days?|three months?)\b/.test(value)) return { periodDays: 90, periodKey: 'rolling' };
  return { periodDays: 30, periodKey: 'rolling' };
}

export function classifyApolloQuestion(question) {
  const value = String(question || '').toLowerCase();
  const period = periodFromQuestion(value);
  if (/\b(what needs my attention|morning brief|operational brief|what is happening|what's happening)\b/.test(value)) return { kind: 'analytics', focus: 'overview', ...period };
  if (/\b(health|healthy|system|systems|backend|bridge|database|vercel|service|services|online|down)\b/.test(value)) return { kind: 'health', ...period };
  if (/\b(image|images|photo|photos|processing queue|product loader|archived image|archived images)\b/.test(value)) return { kind: 'images', ...period };
  if (/\b(search|searches|searched|searching|no results?|zero results?)\b/.test(value)) return { kind: 'analytics', focus: 'search', ...period };
  if (/\b(basket|baskets|abandoned cart|abandoned carts|checkout)\b/.test(value)) return { kind: 'analytics', focus: 'baskets', ...period };
  if (/\b(view|views|viewed|viewing|duration|attention|category|categories|customer interest|customers looking)\b/.test(value)) return { kind: 'analytics', focus: 'customer_attention', ...period };
  if (/\b(order|orders|revenue|sales|average order|repeat customer)\b/.test(value)) return { kind: 'analytics', focus: 'orders', ...period };
  return { kind: 'analytics', focus: 'overview', ...period };
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
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      const error = new Error('Apollo request cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

export async function waitForApolloJob(jobId, signal) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    await wait(attempt < 30 ? 2000 : 4000, signal);
    const job = await readJson(`/api/codex-analytics-jobs?id=${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' });
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Apollo analysis failed');
  }
  throw new Error('Apollo is taking longer than expected. Ask again shortly.');
}

function healthAnswer(payload) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  const concerns = checks.filter((check) => ['critical', 'warning', 'unknown'].includes(check.state));
  return {
    type: 'health', title: 'Proto systems health',
    summary: concerns.length ? `${concerns.length} monitored area${concerns.length === 1 ? '' : 's'} need attention. ${concerns.map((item) => `${item.label}: ${item.summary}`).join(' ')}` : 'All monitored Proto backend systems are healthy.',
    findings: concerns.slice(0, 8).map((item) => ({ severity: item.state === 'critical' ? 'high' : 'medium', title: item.label, explanation: item.summary, recommendedAction: item.action || 'Open Backend Health for the latest technical evidence.', evidence: [item.detail].filter(Boolean) })),
    limitations: [], sources: ['Backend Health'], section: 'backend-health', generatedAt: payload?.generatedAt,
  };
}

function imageAnswer(payload) {
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

async function analyticsAnswer(classification, signal) {
  const focus = ANALYTICS_FOCUS.has(classification.focus) ? classification.focus : 'overview';
  const request = { periodDays: classification.periodDays, focus };
  if (classification.periodKey === 'today') request.periodKey = 'today';
  const created = await readJson('/api/codex-analytics-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  const report = created.result || await waitForApolloJob(created.id || created.jobId, signal);
  return { ...report, type: 'analytics', title: focus === 'overview' ? 'Proto operational brief' : 'Apollo operational answer', sources: FOCUS_SOURCES[focus], section: 'analytics', periodDays: classification.periodDays, periodLabel: classification.periodKey === 'today' ? 'Today' : `${classification.periodDays}-day view` };
}

export async function askApolloOperations(question, { signal } = {}) {
  const classification = classifyApolloQuestion(question);
  if (classification.kind === 'health') return healthAnswer(await readJson('/api/backend-health', { signal, cache: 'no-store' }));
  if (classification.kind === 'images') return imageAnswer(await readJson('/api/image-processing-jobs', { signal, cache: 'no-store' }));
  return analyticsAnswer(classification, signal);
}
