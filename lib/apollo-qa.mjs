const topics = [
  ['live', /\b(who(?:'s| is)? online|online now|currently online|live customers|customers online)\b/],
  ['positill', /\b(positill|pos sales|pos revenue|point of sale)\b/],
  ['activeTime', /\b(time spent|active time|browsing time|how long.*site|duration.*site)\b/],
  ['baskets', /\b(baskets?|carts?|basket value|cart value|abandoned)\b/],
  ['searches', /\b(search(?:es|ed|ing)?|no results?|zero results?|popular terms?)\b/],
  ['interest', /\b(viewed|views|popular products?|popular categor(?:y|ies)|interest)\b/],
  ['orders', /\b(sales|revenue|orders?|turnover|order value)\b/],
];

const periodWords = [
  { kind: 'day', pattern: /\b(today|daily|this day)\b/ },
  { kind: 'week', pattern: /\b(this week|weekly|week to date)\b/ },
  { kind: 'month', pattern: /\b(this month|monthly|month to date)\b/ },
  { kind: 'custom', pattern: /\b(custom range|date range|between \d{4}-\d{2}-\d{2})\b/ },
];

function formatMoney(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(value)
    : 'unknown';
}

function formatWindow(window) {
  if (!window?.start || !window?.end) return 'the selected reporting period';
  const fmt = value => new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return `${fmt(window.start)} to ${fmt(window.end)} (SAST)`;
}

function evidence(status, data, source, report) {
  const window = status?.window || report?.window || null;
  const freshness = status?.lastSuccessfulAt || status?.checkedAt || report?.checkedAt || null;
  return {
    status: status?.data == null ? 'unavailable' : (status.stale || report?.stale || status.complete === false || status.status === 'partial' ? 'partial' : 'available'),
    source: status?.source || source,
    lastSuccessfulAt: freshness,
    period: formatWindow(window),
    data,
  };
}

function unavailable(topic, report, source = 'Apollo reporting sources') {
  const status = report?.[topic];
  return {
    status: 'unavailable',
    answer: status?.reason ? `This information is unavailable: ${status.reason}` : 'This information is unavailable from the connected reporting sources.',
    source: status?.source || source,
    lastSuccessfulAt: status?.lastSuccessfulAt || status?.checkedAt || report?.checkedAt || null,
    period: formatWindow(status?.window || report?.window),
  };
}

function finish(answer, meta, { caution = '', status } = {}) {
  return {
    status: status || (meta.status === 'available' ? 'answered' : meta.status),
    answer: [caution, answer].filter(Boolean).join(' '),
    source: meta.source,
    lastSuccessfulAt: meta.lastSuccessfulAt,
    period: meta.period,
  };
}

function topTerms(report, surface) {
  const sources = report?.searchActivity?.data?.surfaces;
  if (!sources) return null;
  const requested = surface === 'instore' ? ['instore'] : surface === 'main' ? ['main'] : ['main', 'instore'];
  return requested.flatMap(key => (sources[key]?.topTerms || []).map(term => ({
    ...term,
    source: key,
    coverage: sources[key]?.coverage || 'unknown',
  })));
}

export function answerApolloQuestion(question, { report, liveReport, selectedPeriod } = {}) {
  const query = String(question || '').trim().slice(0, 240).toLowerCase();
  if (!query) return { status: 'unsupported', answer: 'Enter a question about online customers, baskets, searches, product interest, orders, or Positill.' };
  if (/\b(forecast|predict|prediction|will .* grow|next year|future sales|expected to grow)\b/.test(query)) {
    return { status: 'unsupported', answer: 'Apollo currently reports recorded activity; it does not forecast or predict future sales.' };
  }

  const requestedPeriod = periodWords.find(row => row.pattern.test(query))?.kind;
  if (requestedPeriod && requestedPeriod !== selectedPeriod) {
    return { status: 'needs_period', answer: `Your question asks about ${requestedPeriod === 'day' ? 'today' : requestedPeriod === 'week' ? 'this week' : requestedPeriod === 'month' ? 'this month' : 'a custom range'}. Change the report Period control to that range first; Apollo will answer from that report.` };
  }

  const topic = topics.find(([, pattern]) => pattern.test(query))?.[0];
  if (!topic) return { status: 'unsupported', answer: 'I can answer questions about who is online, basket snapshots, recorded searches, product/category views, website orders, and the status of Positill data. I cannot infer beyond those reports.' };

  if (topic === 'live') {
    const status = liveReport?.live;
    if (!status?.data) return unavailable('live', liveReport, 'portal.customer_presence + customer_account_carts');
    const meta = evidence(status, status.data, 'portal.customer_presence + customer_account_carts', liveReport);
    meta.period = `Live snapshot; signed-in customers active within ${status.data.freshnessSeconds ?? 'unknown'} seconds of the last successful read`;
    const customers = status.data.customers || [];
    if (!customers.length) return finish('No signed-in customers were recorded as active in the recent-presence window. This does not cover anonymous visitors.', meta, { caution: meta.status === 'partial' ? 'This view is partial.' : '' });
    const names = customers.slice(0, 20).map(person => {
      const section = person.currentSection ? ` on ${person.currentSection}` : '';
      const basket = person.basket?.value == null ? '' : `, basket snapshot ${formatMoney(person.basket.value)} incl. VAT`;
      return `${person.name || 'Signed-in customer'}${section}${basket}`;
    }).join('; ');
    return finish(`${customers.length} signed-in customer${customers.length === 1 ? ' is' : 's are'} recently active: ${names}${customers.length > 20 ? '; more omitted' : ''}. Anonymous visitors are not included.`, meta, { caution: meta.status === 'partial' ? 'This view is partial.' : '' });
  }

  if (topic === 'positill') {
    const status = report?.positill;
    if (!status?.data) return unavailable('positill', report, 'existing read-only Positill bridge');
    const meta = evidence(status, status.data, 'existing read-only Positill bridge', report);
    return finish('I cannot report verified Positill sales yet. The connected bridge only provides raw line aggregates; VAT basis, credit-note treatment, document types, and website-order references are not verified.', meta, { status: 'unavailable' });
  }

  const sourceEnvelope = report?.[topic] || (topic === 'interest' ? report?.searchActivity : null);
  if (!sourceEnvelope?.data) return unavailable(topic, report);
  const meta = evidence(sourceEnvelope, sourceEnvelope.data, sourceEnvelope.source, report);
  const incomplete = meta.status === 'partial' ? 'Partial or unverified evidence only.' : '';
  const surface = /\b(instore|in-store|in store)\b/.test(query) ? 'instore' : /\b(main website|main site)\b/.test(query) ? 'main' : 'all';

  if (topic === 'baskets') {
    const data = sourceEnvelope.data;
    return finish(`${data.openBaskets ?? 'Unknown'} saved baskets contain ${data.totalUnits ?? 'unknown'} units with snapshot value ${formatMoney(data.valueInclVat)} incl. VAT. Baskets are not sales.`, meta, { caution: incomplete });
  }
  if (topic === 'activeTime') {
    const data = sourceEnvelope.data;
    if (meta.status !== 'available' || data.activeSeconds == null) return unavailable(topic, report);
    return finish(`${data.activeSeconds} estimated seconds across ${data.activeCustomers ?? 'unknown'} signed-in customers, based on visible, recently interacted sessions.`, meta);
  }
  if (topic === 'positill') return unavailable(topic, report);
  if (topic === 'searches') {
    const activityTerms = topTerms(report, surface);
    if (activityTerms?.length) {
      const zeroOnly = /\b(no results?|zero results?)\b/.test(query);
      const selectedTerms = activityTerms.filter(row => !zeroOnly || row.zeroResults > 0)
        .sort((a, b) => zeroOnly ? b.zeroResults - a.zeroResults || b.searches - a.searches || a.term.localeCompare(b.term) : b.searches - a.searches || a.term.localeCompare(b.term));
      const terms = selectedTerms.slice(0, 5)
        .map(row => `${row.term} (${row.searches}, ${row.source}, ${row.coverage} coverage${row.zeroResults ? `, ${row.zeroResults} no-result` : ''})`).join('; ');
      const activityMeta = evidence(report.searchActivity, report.searchActivity.data, report.searchActivity.source, report);
      return finish(terms ? `${zeroOnly ? 'Recorded searches with no results' : 'Top recorded searches'}: ${terms}.` : `${zeroOnly ? 'No no-result search terms' : 'No search terms'} are available in the source-separated activity report.`, activityMeta, { caution: activityMeta.status === 'partial' ? 'Partial coverage.' : '' });
    }
    if (surface !== 'all') {
      const activityMeta = report?.searchActivity?.data
        ? evidence(report.searchActivity, report.searchActivity.data, report.searchActivity.source, report)
        : evidence(sourceEnvelope, sourceEnvelope.data, sourceEnvelope.source, report);
      return finish(`I cannot isolate ${surface === 'main' ? 'Main website' : 'Instore'} searches from the available legacy Analytics records; those records do not include a source field.`, activityMeta, { status: 'partial' });
    }
    const data = sourceEnvelope.data;
    const zeroOnly = /\b(no results?|zero results?)\b/.test(query);
    const selectedTerms = (data.topTerms || []).filter(row => (surface === 'all' || data.surface === surface) && (!zeroOnly || row.zeroResults > 0))
      .sort((a, b) => zeroOnly ? b.zeroResults - a.zeroResults || b.searches - a.searches || a.term.localeCompare(b.term) : b.searches - a.searches || a.term.localeCompare(b.term));
    const rows = selectedTerms.slice(0, 5).map(row => `${row.term} (${row.searches}, ${row.zeroResults} no-result)`).join('; ');
    const caution = [incomplete, 'Legacy search records do not identify Main versus Instore.'].filter(Boolean).join(' ');
    return finish(rows ? `${zeroOnly ? 'Legacy searches with no results' : 'Top recorded legacy searches'}: ${rows}.` : `No usable ${zeroOnly ? 'no-result ' : ''}search terms are available for this period.`, meta, { caution, status: meta.status === 'available' ? 'partial' : meta.status });
  }
  if (topic === 'interest') {
    const reports = report?.searchActivity?.data?.surfaces;
    if (!reports) return unavailable('searchActivity', report, 'apollo_activity_events');
    const keys = surface === 'all' ? ['main', 'instore'] : [surface];
    const rows = keys.flatMap(key => {
      const feed = reports[key];
      return [...(feed?.topProducts || []).map(row => ({ label: row.product, count: row.views, kind: 'views', key })),
        ...(feed?.topCategories || []).map(row => ({ label: row.category, count: row.views, kind: 'category views', key }))];
    }).sort((a, b) => b.count - a.count).slice(0, 5);
    const activityMeta = evidence(report.searchActivity, report.searchActivity.data, report.searchActivity.source, report);
    const text = rows.length ? rows.map(row => `${row.label} (${row.count} ${row.kind}, ${row.key})`).join('; ') : 'No product or category views are available in the activity report.';
    return finish(text, activityMeta, { caution: activityMeta.status === 'partial' ? 'Partial coverage.' : '' });
  }
  if (topic === 'orders') {
    const data = sourceEnvelope.data;
    if (/\b(compare|comparison|difference|versus|vs\.?|change|compared|growth)\b/.test(query)) {
      const metricKey = /\b(count|number of orders|orders)\b/.test(query) && !/order value|sales|revenue/.test(query) ? 'orderCount' : 'revenue';
      const metric = data.comparison?.metrics?.[metricKey];
      if (!metric || metric.status !== 'available') return finish(`I cannot compare ${metricKey === 'revenue' ? 'website order value' : 'recorded website order counts'} because one or both periods are incomplete.`, meta, { status: 'unavailable' });
      const amount = metric.delta === 0 ? 'no change' : `${metric.delta > 0 ? '+' : ''}${metricKey === 'revenue' ? formatMoney(metric.delta) : metric.delta}`;
      const current = metricKey === 'revenue' ? formatMoney(metric.current) : metric.current;
      const previous = metricKey === 'revenue' ? formatMoney(metric.previous) : metric.previous;
      const percentage = metric.percentChange == null ? 'percentage change unavailable from a zero baseline' : `${metric.percentChange > 0 ? '+' : ''}${metric.percentChange}%`;
      return finish(`${metricKey === 'revenue' ? 'Website order value' : 'Recorded website orders'}: ${current} current vs ${previous} previous (${amount}; ${percentage}). This is not Positill sales.`, meta, { caution: incomplete || 'Order statuses are not the same as completed/reconciled sales.' });
    }
    if (data.revenue == null) return finish(`There are ${data.orders ?? 'unknown'} recorded website orders, but their value is unknown. Website order value is not Positill sales.`, meta, { caution: incomplete || 'Do not interpret this as completed or reconciled sales.', status: meta.status });
    return finish(`${data.orders} recorded website orders have value ${formatMoney(data.revenue)} incl. VAT; cancelled orders are excluded. This is website order value, not Positill sales.`, meta, { caution: incomplete || 'Order statuses are not the same as completed/reconciled sales.' });
  }
  return { status: 'unsupported', answer: 'I could not map that question to a verified Apollo report.' };
}

