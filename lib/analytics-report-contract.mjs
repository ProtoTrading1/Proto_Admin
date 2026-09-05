const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, nonempty = false) => typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0);
export const isAnalysisId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isWorkerId = (value) => text(value, 100, true) && value === value.trim();

/** Validate before normalization; coercing arbitrary JSON is not report validation. */
export function analyticsEvidenceReferences(snapshot = {}) {
  const references = new Set();
  const available = (source) => source?.status === 'available';
  const scalar = (reference, value, source) => {
    if (available(source) && value !== null && value !== undefined && Number.isFinite(Number(value))) references.add(reference);
  };
  scalar('orders.count', snapshot?.orders?.count, snapshot?.orders?.source);
  scalar('orders.revenueExVat', snapshot?.orders?.revenueExVat, snapshot?.orders?.source);
  scalar('orders.averageValueExVat', snapshot?.orders?.averageValueExVat, snapshot?.orders?.source);
  scalar('orders.customers', snapshot?.orders?.customers, snapshot?.orders?.source);
  scalar('search.total', snapshot?.search?.total, snapshot?.search?.source);
  scalar('search.noResults', snapshot?.search?.noResults, snapshot?.search?.source);
  scalar('search.orders', snapshot?.search?.orders, snapshot?.search?.source);
  scalar('search.revenue', snapshot?.search?.revenue, snapshot?.search?.source);
  scalar('baskets.outstanding', snapshot?.baskets?.outstanding, snapshot?.baskets?.source);
  scalar('baskets.valueInclVat', snapshot?.baskets?.valueInclVat, snapshot?.baskets?.source);
  scalar('attention.totalActiveSeconds', snapshot?.attention?.totalActiveSeconds, snapshot?.attention?.source);
  if (available(snapshot?.operations?.backendHealth?.source)) references.add('operations.backendHealth');
  if (available(snapshot?.operations?.imageProcessing?.source)) references.add('operations.imageProcessing');
  const visitBusiness = (value, prefix, source) => {
    if (!available(source) || value === null || value === undefined) return;
    if (typeof value === 'number' || typeof value === 'boolean') references.add(prefix);
    else if (record(value)) Object.entries(value).forEach(([key, child]) => visitBusiness(child, `${prefix}.${key}`, source));
  };
  Object.entries(snapshot?.business || {}).forEach(([domain, row]) => {
    Object.entries(row || {}).filter(([key]) => key !== 'source').forEach(([key, value]) => visitBusiness(value, `business.${domain}.${key}`, row?.source));
  });
  const visit = (rows) => (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (/^[PSC]\d{3}$/.test(String(row?.id || ''))) references.add(String(row.id));
  });
  if (available(snapshot?.attention?.source)) { visit(snapshot?.attention?.products); visit(snapshot?.attention?.categories); }
  if (available(snapshot?.orders?.source)) { visit(snapshot?.orders?.topProducts); visit(snapshot?.orders?.topCategories); }
  if (available(snapshot?.search?.source)) visit(snapshot?.search?.zeroResultTerms);
  return references;
}

export function validAnalyticsReport(report, { allowedReferences, requireCitations = false } = {}) {
  if (!record(report) || !text(report.summary, 1200, true)) return false;
  if (!Array.isArray(report.findings) || report.findings.length > 8) return false;
  if (!Array.isArray(report.limitations) || report.limitations.length > 5 || !report.limitations.every((item) => text(item, 300))) return false;
  if (Object.keys(report).some((key) => !['summary', 'findings', 'limitations'].includes(key))) return false;
  const validReference = (entry) => {
    const match = String(entry || '').match(/^\[([^\]]+)\]\s+\S/);
    if (!requireCitations) return true;
    return Boolean(match && allowedReferences?.has(match[1]));
  };
  return report.findings.every((item) => record(item)
    && ['high', 'medium', 'low'].includes(item.severity)
    && text(item.title, 160, true) && text(item.explanation, 800, true)
    && text(item.recommendedAction, 600)
    && Array.isArray(item.evidence) && (!requireCitations || item.evidence.length > 0) && item.evidence.length <= 5 && item.evidence.every((entry) => text(entry, 240) && validReference(entry))
    && Object.keys(item).every((key) => ['severity', 'title', 'explanation', 'recommendedAction', 'evidence'].includes(key)));
}
