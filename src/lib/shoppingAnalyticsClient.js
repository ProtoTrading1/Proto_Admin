const evidenceLimits = { term: 200, product: 128, department: 160 };
const validEvidence = (type, value) => evidenceLimits[type] && typeof value === 'string' && value.trim() && value.length <= evidenceLimits[type];
export function analyticsQuery({ days = 30, source = 'all', includeInternal = false, customerId, customerSearch, evidenceType, evidenceValue, evidenceSource } = {}) {
  const period = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const evidence = validEvidence(evidenceType, evidenceValue);
  return new URLSearchParams({ days: String(period), source: ['all', 'main', 'instore'].includes(source) ? source : 'all', includeInternal: includeInternal ? 'true' : 'false', ...(customerId ? { customerId } : {}), ...(customerSearch ? { customerSearch } : {}), ...(evidence ? { evidenceType, evidenceValue: evidenceValue.trim(), ...(['main','instore','unknown'].includes(evidenceSource) ? {evidenceSource} : {}) } : {}) }).toString();
}

export async function loadShoppingAnalytics(filters, { signal, fetchImpl = fetch, getAccessToken } = {}) {
  if(filters?.evidenceType && !validEvidence(filters.evidenceType,filters.evidenceValue))throw new Error('This supporting record selection is unavailable; use a specific term, product or department.');
  const token = getAccessToken ? await getAccessToken() : null;
  if (getAccessToken && !token) throw new Error('Sign in with an approved admin account to view customer analytics.');
  const response = await fetchImpl(`/api/shopping-analytics-dashboard?${analyticsQuery(filters)}`, {
    method: 'GET', signal, cache: 'no-store', credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Analytics returned an unreadable response. Refresh to try again.'); }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error('Sign in with an approved admin account to view customer analytics.');
    throw new Error(data?.error || 'Analytics could not be loaded. Refresh to try again.');
  }
  if (!data || typeof data !== 'object' || (filters?.customerSearch ? !Array.isArray(data.customerMatches) : filters?.customerId ? !data.customer || data.customer.id !== filters.customerId : filters?.evidenceType ? !data.evidence || data.evidence.type !== filters.evidenceType || data.evidence.value !== filters.evidenceValue?.trim() : !data.summary)) throw new Error('Analytics returned an incomplete response. Refresh to try again.');
  return data;
}

export function numberLabel(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-ZA'); }
export function rateLabel(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }

/** Changes describe recorded counts, never improvement or causal impact. */
export function comparisonLabel(metric, { rate = false } = {}) {
  if (!metric) return 'Previous period not supplied';
  if (metric.status === 'new_recorded_activity') return 'Newly recorded activity; percentage change unavailable';
  if (metric.status === 'no_recorded_history') return 'No recorded history to compare';
  if (metric.current == null || metric.previous == null || metric.absoluteDelta == null || metric.status === 'not_comparable') {
    const reason = String(metric.reason || '');
    const code = /^(current|previous)_(events|orders|customers)_(unavailable|partial)$/.exec(reason);
    if(code)return `${code[1]==='current'?'Current':'Previous'} ${code[2]==='events'?'shopping tracking':code[2]==='orders'?'order records':'customer profiles'}: ${code[3]==='partial'?'limited records':'unavailable'}; comparison unavailable`;
    if(/^(current|previous)_customer_exclusions_incomplete$/.test(reason))return 'Internal activity could not be fully excluded; comparison unavailable';
    return reason==='metric_unavailable' || !reason ? 'Comparison unavailable' : reason;
  }
  if (!Number.isFinite(metric.absoluteDelta)) return 'Comparison unavailable';
  const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('en-ZA', { maximumFractionDigits: 1 })}`;
  if (rate) return `${signed(metric.absoluteDelta * 100)} percentage points`;
  return `${signed(metric.absoluteDelta)} recorded${Number.isFinite(metric.relativeDelta) ? ` (${signed(metric.relativeDelta * 100)}%)` : ''}`;
}
