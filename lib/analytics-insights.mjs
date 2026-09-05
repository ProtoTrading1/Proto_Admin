function number(value, max = 1_000_000_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : 0;
}

function cleanRows(rows = [], limit = 30) {
  return rows.slice(0, limit).map((row) => ({
    id: String(row.id || row.code || '').trim().slice(0, 200),
    label: String(row.label || row.name || row.term || '').trim().slice(0, 200),
    views: number(row.views || row.count || row.searches),
    customers: number(row.customers),
    activeSeconds: number(row.activeSeconds, 86400 * 100000),
    quantity: number(row.qty || row.quantity),
    orders: number(row.orders),
  })).filter((row) => row.id || row.label);
}

function sourceState(input, fallbackAvailable = true) {
  if (input?.source?.status === 'error' || input?.status === 'error') return 'error';
  if (input?.source?.status === 'planned' || input?.status === 'planned') return 'planned';
  if (input?.available === false || input?.source?.status === 'unavailable') return 'unavailable';
  if (input?.available === true || input?.source?.status === 'available') return 'available';
  return fallbackAvailable ? 'available' : 'unavailable';
}

function sourceMetadata(input = {}, fallbackAvailable = true) {
  const status = sourceState(input, fallbackAvailable);
  return {
    status,
    collectedAt: String(input?.source?.collectedAt || input?.generatedAt || input?.collectedAt || '').slice(0, 40) || null,
    windowStart: String(input?.source?.windowStart || input?.since || '').slice(0, 40) || null,
    windowEnd: String(input?.source?.windowEnd || input?.until || '').slice(0, 40) || null,
    timezone: String(input?.source?.timezone || 'Africa/Johannesburg').slice(0, 60),
    complete: status === 'available' && input?.truncated !== true && input?.source?.complete !== false,
    truncated: input?.truncated === true || input?.source?.truncated === true,
    rowCount: Number.isFinite(Number(input?.source?.rowCount ?? input?.rowCount)) ? Number(input?.source?.rowCount ?? input?.rowCount) : null,
    rowLimit: Number.isFinite(Number(input?.source?.rowLimit ?? input?.rowLimit)) ? Number(input?.source?.rowLimit ?? input?.rowLimit) : null,
    reason: status === 'available' ? null : String(input?.source?.reason || input?.reason || 'source_unavailable').slice(0, 80),
  };
}

function cleanOperations(input = {}) {
  const checks = Array.isArray(input?.health?.checks) ? input.health.checks.slice(0, 30).map((check) => ({
    state: String(check?.state || 'unknown').slice(0, 20),
    label: String(check?.label || '').slice(0, 100),
    summary: String(check?.summary || '').slice(0, 240),
    detail: String(check?.detail || '').slice(0, 240),
  })) : [];
  const jobs = Array.isArray(input?.images?.jobs) ? input.images.jobs : [];
  const imageStatuses = jobs.reduce((result, job) => {
    const status = String(job?.status || 'unknown').toLowerCase().slice(0, 30);
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  return {
    backendHealth: { source: sourceMetadata(input?.health, checks.length > 0), checks },
    imageProcessing: { source: sourceMetadata(input?.images, Array.isArray(input?.images?.jobs)), total: jobs.length, statuses: imageStatuses },
  };
}

const BUSINESS_METRICS = Object.freeze({
  catalogue: ['liveProducts', 'uncategorized'],
  archive: ['archivedProducts', 'approvalPending', 'recycleBin'],
  customers: ['total'],
  site_content: ['featuredProducts', 'specials', 'bannerConfigured'],
  crm: ['campaigns'],
  product_loader: ['totalEvents', 'sampledEvents'],
  fulfillment: ['total', 'new', 'handedOver', 'inProgress', 'sent', 'paid'],
});

function cleanBusiness(input = {}) {
  const output = {};
  for (const [domain, keys] of Object.entries(BUSINESS_METRICS)) {
    if (!input?.[domain]) continue;
    const row = { source: sourceMetadata(input[domain], false) };
    for (const key of keys) {
      row[key] = key === 'bannerConfigured' ? Boolean(input[domain]?.[key]) : number(input[domain]?.[key]);
    }
    if (domain === 'crm') {
      row.events = {};
      for (const key of ['delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed']) row.events[key] = number(input[domain]?.events?.[key]);
    }
    if (domain === 'product_loader') {
      row.outcomes = {};
      for (const key of ['published', 'archived', 'failed', 'skipped', 'other']) row.outcomes[key] = number(input[domain]?.outcomes?.[key]);
    }
    output[domain] = row;
  }
  for (const domain of ['buying', 'pricing']) {
    if (input?.[domain]) output[domain] = { source: sourceMetadata(input[domain], false) };
  }
  return output;
}

export function normalizeInsightSnapshot(input = {}) {
  const periodDays = [1, 7, 30, 90].includes(Number(input.periodDays)) ? Number(input.periodDays) : 30;
  return {
    periodDays,
    attention: {
      available: Boolean(input.attention?.available),
      source: sourceMetadata(input.attention, Boolean(input.attention?.available)),
      totalActiveSeconds: number(input.attention?.totalActiveSeconds, 86400 * 100000),
      products: cleanRows(input.attention?.products),
      categories: cleanRows(input.attention?.categories),
    },
    orders: {
      source: sourceMetadata(input.orders, Boolean(input.orders?.summary)),
      count: number(input.orders?.summary?.totalOrders),
      revenueExVat: number(input.orders?.summary?.totalRevenue),
      averageValueExVat: number(input.orders?.summary?.avgOrderValue),
      customers: number(input.orders?.summary?.customersWhoOrdered),
      repeatCustomerPct: number(input.orders?.summary?.repeatCustomerPct, 100),
      topProducts: cleanRows(input.orders?.topProducts || input.orders?.topOrderedProducts),
      topCategories: cleanRows(input.orders?.topCategories || input.orders?.topOrderedCategories),
    },
    search: {
      source: sourceMetadata(input.search, Boolean(input.search?.kpis)),
      total: number(input.search?.kpis?.totalSearches),
      noResults: number(input.search?.kpis?.searchesNoResults),
      orders: number(input.search?.kpis?.searchesToOrders),
      revenue: number(input.search?.kpis?.revenue),
      zeroResultTerms: cleanRows(input.search?.zeroResultTerms, 20),
    },
    baskets: {
      source: sourceMetadata(input.baskets, Boolean(input.baskets)),
      outstanding: number(input.baskets?.basketCount ?? input.baskets?.summary?.basketCount),
      valueInclVat: number(input.baskets?.totalValue ?? input.baskets?.summary?.totalValue),
      stale: number(input.baskets?.staleCount ?? input.baskets?.coldCount ?? input.baskets?.goneColdCount ?? input.baskets?.summary?.staleCount),
      units: number(input.baskets?.totalUnits ?? input.baskets?.summary?.totalUnits),
    },
    operations: cleanOperations(input.operations),
    business: cleanBusiness(input.business),
  };
}

function referencedRows(rows = [], kind, registry, referenceMap, limit = 30) {
  return rows.slice(0, limit).map((row) => {
    const sourceId = String(row.id || row.code || '').trim().slice(0, 200);
    if (!sourceId) return null;
    const registryKey = `${kind}:${sourceId.toLowerCase()}`;
    let id = registry.get(registryKey);
    if (!id) {
      const sequence = [...registry.values()].filter((value) => value.startsWith(kind)).length + 1;
      id = `${kind}${String(sequence).padStart(3, '0')}`;
      registry.set(registryKey, id);
      referenceMap[id] = {
        id: sourceId,
        label: String(row.label || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      };
    }
    return {
    id,
    views: number(row.views || row.count || row.searches),
    customers: number(row.customers),
    activeSeconds: number(row.activeSeconds, 86400 * 100000),
    quantity: number(row.qty || row.quantity),
    orders: number(row.orders),
    };
  }).filter(Boolean);
}

/** AI boundary: aggregate numbers and generated references only. */
export function prepareCodexSnapshot(input = {}) {
  const source = normalizeInsightSnapshot(input);
  const registry = new Map();
  const referenceMap = {};
  const snapshot = {
    periodDays: source.periodDays,
    attention: {
      available: source.attention.available,
      source: source.attention.source,
      totalActiveSeconds: source.attention.source.status === 'available' ? source.attention.totalActiveSeconds : null,
      products: source.attention.source.status === 'available' ? referencedRows(source.attention.products, 'P', registry, referenceMap) : [],
      categories: source.attention.source.status === 'available' ? referencedRows(source.attention.categories, 'C', registry, referenceMap) : [],
    },
    orders: {
      source: source.orders.source,
      count: source.orders.source.status === 'available' ? source.orders.count : null,
      revenueExVat: source.orders.source.status === 'available' ? source.orders.revenueExVat : null,
      averageValueExVat: source.orders.source.status === 'available' ? source.orders.averageValueExVat : null,
      customers: source.orders.source.status === 'available' ? source.orders.customers : null,
      repeatCustomerPct: source.orders.source.status === 'available' ? source.orders.repeatCustomerPct : null,
      topProducts: source.orders.source.status === 'available' ? referencedRows(source.orders.topProducts, 'P', registry, referenceMap) : [],
      topCategories: source.orders.source.status === 'available' ? referencedRows(source.orders.topCategories, 'C', registry, referenceMap) : [],
    },
    search: {
      source: source.search.source,
      total: source.search.source.status === 'available' ? source.search.total : null,
      noResults: source.search.source.status === 'available' ? source.search.noResults : null,
      orders: source.search.source.status === 'available' ? source.search.orders : null,
      revenue: source.search.source.status === 'available' ? source.search.revenue : null,
      zeroResultTerms: source.search.source.status === 'available' ? referencedRows(
        (Array.isArray(input.search?.zeroResultTerms) ? input.search.zeroResultTerms : [])
          .filter((row) => row?.approvedForAnalysis === true),
        'S', registry, referenceMap, 20,
      ) : [],
    },
    baskets: source.baskets.source.status === 'available' ? source.baskets : {
      ...source.baskets,
      outstanding: null,
      valueInclVat: null,
      stale: null,
      units: null,
    },
    operations: source.operations,
    business: Object.fromEntries(Object.entries(source.business).map(([domain, row]) => [domain,
      row.source.status === 'available' ? row : { source: row.source },
    ])),
  };
  return { snapshot, referenceMap };
}

export function normalizeCodexSnapshot(input = {}) {
  return prepareCodexSnapshot(input).snapshot;
}

export function applyCodexReferenceMap(report, referenceMap = {}) {
  const replacements = new Map(Object.entries(referenceMap).map(([reference, item]) => {
    const sourceId = String(item?.id || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    const label = String(item?.label || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    return [reference, label ? `${label} (${sourceId})` : sourceId];
  }).filter(([, display]) => display));
  const pattern = replacements.size
    ? new RegExp(`\\b(?:${[...replacements.keys()].join('|')})\\b`, 'g')
    : null;
  const replace = (value) => pattern
    ? String(value || '').replace(pattern, (reference) => replacements.get(reference) || reference)
    : String(value || '');
  return {
    ...report,
    summary: replace(report?.summary),
    findings: Array.isArray(report?.findings) ? report.findings.map((item) => ({
      ...item,
      title: replace(item.title),
      explanation: replace(item.explanation),
      recommendedAction: replace(item.recommendedAction),
      evidence: Array.isArray(item.evidence) ? item.evidence.map(replace) : [],
    })) : [],
    limitations: Array.isArray(report?.limitations) ? report.limitations.map(replace) : [],
  };
}

function finding(severity, title, explanation, recommendedAction, evidence) {
  return { severity, title, explanation, recommendedAction, evidence };
}

export function buildAnalyticsInsights(input = {}) {
  const snapshot = normalizeInsightSnapshot(input);
  const findings = [];
  const noResultRate = snapshot.search.total ? snapshot.search.noResults / snapshot.search.total : 0;
  const searchConversion = snapshot.search.total ? snapshot.search.orders / snapshot.search.total : 0;

  if (snapshot.search.total >= 50 && noResultRate >= 0.1) {
    findings.push(finding(
      noResultRate >= 0.2 ? 'high' : 'medium',
      'Customers often search without finding a product',
      `${Math.round(noResultRate * 100)}% of ${snapshot.search.total} searches returned no results.`,
      'Review the leading no-result terms against product titles, codes, synonyms and current range gaps.',
      snapshot.search.zeroResultTerms.slice(0, 5).map((row) => `${row.label}: ${row.views} searches`),
    ));
  }

  if (snapshot.search.total >= 100 && searchConversion < 0.01) {
    findings.push(finding('high', 'Search rarely leads to an order', `${snapshot.search.orders} of ${snapshot.search.total} searches were attributed to an order.`, 'Check search-result relevance, product availability and whether search attribution is recording correctly.', [`Search conversion ${(searchConversion * 100).toFixed(1)}%`]));
  }

  if (snapshot.baskets.outstanding > 0) {
    const ratio = snapshot.orders.revenueExVat ? snapshot.baskets.valueInclVat / snapshot.orders.revenueExVat : 0;
    findings.push(finding(ratio >= 0.5 ? 'high' : 'medium', 'Meaningful value remains in outstanding baskets', `${snapshot.baskets.outstanding} baskets hold R ${Math.round(snapshot.baskets.valueInclVat).toLocaleString('en-ZA')} including VAT.`, 'Prioritise recent high-value baskets for manual review; do not contact customers automatically.', [`${snapshot.baskets.units} units waiting`, `${snapshot.baskets.stale} gone cold`]));
  }

  if (snapshot.attention.available) {
    const orderedIds = new Set(snapshot.orders.topProducts.map((row) => row.id.toLowerCase()));
    const interestGaps = snapshot.attention.products.filter((row) => row.customers >= 3 && !orderedIds.has(row.id.toLowerCase())).slice(0, 5);
    if (interestGaps.length) {
      findings.push(finding('medium', 'Products hold attention without appearing among top ordered items', 'Customers spend active time on these products, but they do not appear in the leading ordered list.', 'Review price, stock, images, variants, minimum quantity and product wording for these products.', interestGaps.map((row) => `${row.label}: ${Math.round(row.activeSeconds / 60)} active minutes`)));
    }
  }

  if (snapshot.orders.customers >= 10 && snapshot.orders.repeatCustomerPct < 20) {
    findings.push(finding('medium', 'Returning-order share is low in this period', `${snapshot.orders.repeatCustomerPct}% of ordering customers placed more than one order inside the selected period.`, 'Compare this with full customer history before treating the figure as true first-time versus returning behaviour.', [`${snapshot.orders.customers} customers ordered`]));
  }

  const summary = `${snapshot.periodDays}-day view: ${snapshot.orders.count} orders worth R ${Math.round(snapshot.orders.revenueExVat).toLocaleString('en-ZA')} ex VAT, ${snapshot.search.total} searches and ${snapshot.baskets.outstanding} outstanding baskets. ${findings.length ? `${findings.length} area${findings.length === 1 ? '' : 's'} need review.` : 'No threshold-based concern was found.'}`;
  return { generatedAt: new Date().toISOString(), snapshot, summary, findings };
}

export function normalizeCodexReport(input = {}) {
  const severity = new Set(['high', 'medium', 'low']);
  const text = (value, max) => String(value || '').trim().slice(0, max);
  return {
    summary: text(input.summary, 1200),
    findings: Array.isArray(input.findings) ? input.findings.slice(0, 8).map((item) => ({
      severity: severity.has(item?.severity) ? item.severity : 'medium',
      title: text(item?.title, 160),
      explanation: text(item?.explanation, 800),
      recommendedAction: text(item?.recommendedAction, 600),
      evidence: Array.isArray(item?.evidence) ? item.evidence.slice(0, 5).map((line) => text(line, 240)).filter(Boolean) : [],
    })).filter((item) => item.title && item.explanation) : [],
    limitations: Array.isArray(input.limitations) ? input.limitations.slice(0, 5).map((line) => text(line, 300)).filter(Boolean) : [],
  };
}
