export const INSTORE_REVIEW_LABELS = Object.freeze({
  ready: 'Ready to add', attention: 'Needs your attention', listed: 'Already listed', not_found: 'Not found in Positill',
});

export function normalizeReviewSku(value) {
  return String(value || '').trim().toUpperCase();
}

export function uniqueInstoreRows(rows = []) {
  const unique = new Map();
  for (const row of [...rows].sort((a, b) => Number(a.imageSlot || 1) - Number(b.imageSlot || 1)
    || String(a.filename || '').localeCompare(String(b.filename || '')))) {
    const key = normalizeReviewSku(row.code) || `file:${row.filename}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

export function buildInstoreReview(rows, { isReady = () => false, getBlocker = () => '' } = {}) {
  return uniqueInstoreRows(rows).map((row) => {
    const listedMain = Boolean(row.existingOnMainSite || String(row.websiteStatus).toLowerCase() === 'live');
    const listedInstore = Boolean(row.existingInstore || row.status === 'instore');
    const unavailable = row.existingMainSiteLookupFailed || row.existingInstoreLookupFailed
      || row.positillSource === 'unavailable' || row.lookupError;
    const confirmedMissing = !unavailable && !row.parseError && row.group === 'not_found'
      && (row.positillSource === 'erp_sql' || row.positillLookupStatus === 'not_found');
    const state = listedMain || listedInstore ? 'listed' : confirmedMissing ? 'not_found'
      : !unavailable && isReady(row) ? 'ready' : 'attention';
    const reason = state === 'listed' ? [listedInstore && 'Already in Instore', listedMain && 'On main site'].filter(Boolean).join(' · ')
      : state === 'not_found' ? 'Check the image filename and exact Positill SKU.'
        : getBlocker(row) || (state === 'ready' ? 'Ready to add to Instore' : 'Review the source data before adding.');
    return { row, key: row.filename, sku: normalizeReviewSku(row.code), state, reason, listedMain, listedInstore,
      canReview: Boolean(row.file && row.code && state !== 'listed' && state !== 'not_found') };
  });
}

export function summarizeInstoreReview(entries = []) {
  return entries.reduce((counts, entry) => ({ ...counts, total: counts.total + 1, [entry.state]: counts[entry.state] + 1 }),
    { total: 0, ready: 0, attention: 0, listed: 0, not_found: 0 });
}

export function filterInstoreReview(entries, { query = '', status = 'working', selectedOnly = false, selected = new Set(), destination = '', productGroup = '' } = {}) {
  const term = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const row = entry.row;
    const description = [row.instoreCopy?.title, row.instoreCopy?.description, row.description, row.sqlRow?.DESCRIPTION, row.sqlRow?.description, row.sqlRow?.title, row.title].filter(Boolean).join(' ');
    const group = String(row.productGroup || row.sqlRow?.GROUP || row.sqlRow?.group || '');
    return (!term || `${entry.sku} ${description}`.toLowerCase().includes(term))
      && (selectedOnly ? selected.has(entry.key) : status === 'working' ? entry.state !== 'listed'
        : status === 'instore' ? entry.listedInstore : status === 'main' ? entry.listedMain
          : status === 'all' || entry.state === status)
      && (!destination || (row.instoreCategoryPath || []).join(' › ') === destination)
      && (!productGroup || group === productGroup);
  });
}

export function groupInstoreDestinations(entries = []) {
  const groups = new Map();
  for (const { row, sku } of entries) {
    const destination = row.instoreCategoryPath?.join(' › ') || 'Unassigned';
    const group = groups.get(destination) || { destination, count: 0, skus: [] };
    group.count += 1;
    group.skus.push(sku);
    groups.set(destination, group);
  }
  return [...groups.values()];
}
