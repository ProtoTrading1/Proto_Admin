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

export function normalizeInsightSnapshot(input = {}) {
  const periodDays = [7, 30, 90].includes(Number(input.periodDays)) ? Number(input.periodDays) : 30;
  return {
    periodDays,
    attention: {
      available: Boolean(input.attention?.available),
      totalActiveSeconds: number(input.attention?.totalActiveSeconds, 86400 * 100000),
      products: cleanRows(input.attention?.products),
      categories: cleanRows(input.attention?.categories),
    },
    orders: {
      count: number(input.orders?.summary?.totalOrders),
      revenueExVat: number(input.orders?.summary?.totalRevenue),
      averageValueExVat: number(input.orders?.summary?.avgOrderValue),
      customers: number(input.orders?.summary?.customersWhoOrdered),
      repeatCustomerPct: number(input.orders?.summary?.repeatCustomerPct, 100),
      topProducts: cleanRows(input.orders?.topProducts || input.orders?.topOrderedProducts),
      topCategories: cleanRows(input.orders?.topCategories || input.orders?.topOrderedCategories),
    },
    search: {
      total: number(input.search?.kpis?.totalSearches),
      noResults: number(input.search?.kpis?.searchesNoResults),
      orders: number(input.search?.kpis?.searchesToOrders),
      revenue: number(input.search?.kpis?.revenue),
      zeroResultTerms: cleanRows(input.search?.zeroResultTerms, 20),
    },
    baskets: {
      outstanding: number(input.baskets?.basketCount ?? input.baskets?.summary?.basketCount),
      valueInclVat: number(input.baskets?.totalValue ?? input.baskets?.summary?.totalValue),
      stale: number(input.baskets?.staleCount ?? input.baskets?.coldCount ?? input.baskets?.goneColdCount ?? input.baskets?.summary?.staleCount),
      units: number(input.baskets?.totalUnits ?? input.baskets?.summary?.totalUnits),
    },
  };
}

function opaqueRows(rows = [], limit = 30) {
  return rows.slice(0, limit).map((row) => ({
    id: String(row.id || row.code || '').trim().slice(0, 100).replace(/[^a-z0-9._:/-]/gi, ''),
    views: number(row.views || row.count || row.searches),
    customers: number(row.customers),
    activeSeconds: number(row.activeSeconds, 86400 * 100000),
    quantity: number(row.qty || row.quantity),
    orders: number(row.orders),
  })).filter((row) => row.id);
}

/** AI boundary: aggregate numbers and opaque catalogue identifiers only. */
export function normalizeCodexSnapshot(input = {}) {
  const source = normalizeInsightSnapshot(input);
  return {
    periodDays: source.periodDays,
    attention: {
      available: source.attention.available,
      totalActiveSeconds: source.attention.totalActiveSeconds,
      products: opaqueRows(source.attention.products),
      categories: opaqueRows(source.attention.categories),
    },
    orders: {
      count: source.orders.count,
      revenueExVat: source.orders.revenueExVat,
      averageValueExVat: source.orders.averageValueExVat,
      customers: source.orders.customers,
      repeatCustomerPct: source.orders.repeatCustomerPct,
      topProducts: opaqueRows(source.orders.topProducts),
      topCategories: opaqueRows(source.orders.topCategories),
    },
    search: {
      total: source.search.total,
      noResults: source.search.noResults,
      orders: source.search.orders,
      revenue: source.search.revenue,
    },
    baskets: source.baskets,
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
