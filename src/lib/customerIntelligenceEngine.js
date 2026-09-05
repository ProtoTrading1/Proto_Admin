const DAY_MS = 24 * 60 * 60 * 1000;

export const CUSTOMER_INTELLIGENCE_VERSION = 'customer-intelligence.v1';

function text(value) {
  return String(value ?? '').trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value) ? [text(value)] : [];
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function has(value) {
  return Array.isArray(value) ? list(value).length > 0 : Boolean(text(value));
}

function daysSince(value, now) {
  const date = validDate(value);
  const reference = validDate(now);
  if (!date || !reference) return null;
  return Math.max(0, Math.floor((reference.getTime() - date.getTime()) / DAY_MS));
}

function component(key, label, points, maximum, evidence) {
  return { key, label, points, maximum, evidence };
}

function scoreBand(score) {
  if (score === null) return 'insufficient_data';
  if (score >= 75) return 'strong';
  if (score >= 50) return 'developing';
  return 'limited';
}

function finishScore(components, limitations = [], { score = null } = {}) {
  const maximum = components.reduce((sum, item) => sum + item.maximum, 0);
  const calculated = maximum ? Math.round((components.reduce((sum, item) => sum + item.points, 0) / maximum) * 100) : null;
  const finalScore = score === null ? calculated : score;
  return {
    score: finalScore,
    maximum: 100,
    band: scoreBand(finalScore),
    components,
    reasons: components.filter((item) => item.points > 0).map((item) => item.evidence),
    limitations,
  };
}

function monthlySpendPoints(value) {
  const normalized = text(value).toLowerCase().replace(/\s/g, '');
  if (!normalized) return 0;
  if (normalized.includes('50,000+') || normalized.includes('50000+')) return 30;
  if (normalized.includes('25,000') || normalized.includes('25000')) return 24;
  if (normalized.includes('10,000') || normalized.includes('10000')) return 18;
  if (normalized.includes('5,000') || normalized.includes('5000')) return 10;
  return 5;
}

function traderConfidence(customer, summary) {
  const verifiedHistory = positiveNumber(summary.salesLast12Months ?? customer.sales_last_12_months) > 0
    || positiveNumber(summary.orderCount ?? customer.invoice_count) > 0;
  const assignedCode = text(customer.customer_code || customer.account_code);
  const categories = list(customer.product_categories || customer.business_categories);
  const channels = list(customer.sales_channels);
  const businessNarrative = text(customer.business_description);
  const publicEvidence = has(customer.website) || has(customer.vat_number);
  const contactEvidence = has(customer.email) && has(customer.phone);
  const components = [
    component('verified_history', 'Verified Proto history', verifiedHistory ? 30 : 0, 30, verifiedHistory ? 'Recorded Proto sales or orders are linked.' : 'No linked Proto history is available.'),
    component('assigned_code', 'Assigned customer code', assignedCode ? 15 : 0, 15, assignedCode ? 'An assigned customer code is present.' : 'No assigned customer code is present.'),
    component('business_nature', 'Nature of business', categories.length ? 20 : 0, 20, categories.length ? `${categories.length} business category selection${categories.length === 1 ? '' : 's'} supplied.` : 'No business category is supplied.'),
    component('sales_channels', 'Sales channels', channels.length ? 15 : 0, 15, channels.length ? `${channels.length} sales channel selection${channels.length === 1 ? '' : 's'} supplied.` : 'No sales channel is supplied.'),
    component('business_narrative', 'Customer description', businessNarrative ? 10 : 0, 10, businessNarrative ? 'The customer described the business in their own words.' : 'No customer-supplied business description is available.'),
    component('supporting_details', 'Supporting details', publicEvidence ? 5 : 0, 5, publicEvidence ? 'A website or VAT number is supplied.' : 'No website or VAT number is supplied.'),
    component('contactability', 'Contactability', contactEvidence ? 5 : 0, 5, contactEvidence ? 'Both email and phone are supplied.' : 'Email and phone are not both supplied.'),
  ];
  const limitations = [];
  if (has(customer.claimed_customer_code) && !assignedCode) limitations.push('A customer-supplied old code is unverified and contributes no score.');
  if (!verifiedHistory) limitations.push('No linked purchasing history is available to corroborate the application.');
  limitations.push('This score describes available evidence; it does not determine whether the customer should be approved.');
  return finishScore(components, limitations);
}

function customerPotential(customer, summary) {
  const sales = positiveNumber(summary.recordedSales ?? summary.salesLast12Months ?? customer.sales_last_12_months);
  const orderCount = positiveNumber(summary.orderCount ?? customer.invoice_count);
  const averageOrder = positiveNumber(summary.averageOrderValue) || (orderCount ? sales / orderCount : 0);
  const categoryCount = list(customer.product_categories || customer.business_categories).length;
  const spendPoints = monthlySpendPoints(customer.monthly_spend);
  const components = [
    component('recorded_sales', summary.salesPeriodLabel || 'Recorded sales', sales >= 100000 ? 35 : sales >= 50000 ? 28 : sales >= 10000 ? 18 : sales > 0 ? 8 : 0, 35, sales ? `R${Math.round(sales).toLocaleString('en-ZA')} in ${summary.salesPeriodLabel ? summary.salesPeriodLabel.toLowerCase() : 'recorded sales'}.` : 'No recorded sales total is available.'),
    component('stated_spend', 'Stated monthly spend', spendPoints, 30, has(customer.monthly_spend) ? `Applicant selected ${text(customer.monthly_spend)}.` : 'No estimated monthly spend was supplied.'),
    component('ordering_depth', 'Ordering depth', averageOrder >= 10000 ? 20 : averageOrder >= 5000 ? 15 : averageOrder > 0 ? 8 : 0, 20, averageOrder ? `Recorded average order value is about R${Math.round(averageOrder).toLocaleString('en-ZA')}.` : 'Average order value is unavailable.'),
    component('category_fit', 'Category opportunity', categoryCount >= 3 ? 15 : categoryCount === 2 ? 10 : categoryCount === 1 ? 6 : 0, 15, categoryCount ? `${categoryCount} relevant product categor${categoryCount === 1 ? 'y was' : 'ies were'} selected.` : 'No product categories are supplied.'),
  ];
  const limitations = [];
  if (!sales) limitations.push('Potential relies partly on applicant-stated information because recorded sales are unavailable.');
  if (sales && summary.salesSnapshot) limitations.push('The Positill total is an imported financial-year snapshot and may not include later transactions.');
  if (has(customer.monthly_spend)) limitations.push('Estimated monthly spend is customer supplied and has not been independently verified.');
  limitations.push('Potential is an opportunity indicator, not a credit limit or forecast.');
  return finishScore(components, limitations);
}

function engagementHealth(customer, summary, now) {
  const orderCount = positiveNumber(summary.orderCount ?? customer.invoice_count);
  const lastOrder = summary.lastOrderDate || customer.last_purchase_date;
  const inactiveDays = daysSince(lastOrder, now);
  const trend = finiteNumber(summary.salesTrendPercent);
  const ordersLast90Days = positiveNumber(summary.ordersLast90Days);

  if (!orderCount && inactiveDays === null) {
    return finishScore([], [
      'No dated order history is available, so engagement health is not scored.',
      'A missing score must not be treated as poor engagement.',
    ], { score: null });
  }

  const recencyPoints = inactiveDays === null ? 0 : inactiveDays <= 30 ? 45 : inactiveDays <= 60 ? 35 : inactiveDays <= 120 ? 20 : 5;
  const trendPoints = trend === null ? 0 : trend >= 10 ? 30 : trend >= -10 ? 20 : trend >= -30 ? 10 : 0;
  const frequencyPoints = ordersLast90Days >= 3 ? 25 : ordersLast90Days === 2 ? 18 : ordersLast90Days === 1 ? 10 : 0;
  const components = [
    component('recency', 'Order recency', recencyPoints, 45, inactiveDays === null ? 'The last order date is unavailable.' : `The last recorded order was ${inactiveDays} day${inactiveDays === 1 ? '' : 's'} ago.`),
    component('sales_trend', 'Sales trend', trendPoints, 30, trend === null ? 'A comparable sales trend is unavailable.' : `Recorded sales trend is ${trend >= 0 ? '+' : ''}${trend}%.`),
    component('recent_frequency', 'Recent frequency', frequencyPoints, 25, `${ordersLast90Days} recorded order${ordersLast90Days === 1 ? '' : 's'} in the last 90 days.`),
  ];
  const limitations = [];
  if (trend === null) limitations.push('Sales trend is not included in the supplied order summary.');
  if (!ordersLast90Days) limitations.push('Recent order frequency is zero or unavailable.');
  limitations.push('Engagement uses recorded Proto activity only and cannot see purchases made elsewhere.');
  return finishScore(components, limitations);
}

function dataConfidence(customer, summary) {
  const categories = list(customer.product_categories || customer.business_categories);
  const applicationFields = [customer.business_name || customer.name, customer.email, customer.phone, customer.business_description, customer.monthly_spend];
  const completeFields = applicationFields.filter(has).length;
  const structured = categories.length > 0 && list(customer.sales_channels).length > 0;
  const hasOrderSummary = Object.keys(summary).length > 0;
  const linkedHistory = positiveNumber(summary.orderCount ?? customer.invoice_count) > 0
    || positiveNumber(summary.salesLast12Months ?? customer.sales_last_12_months) > 0;
  const components = [
    component('core_profile', 'Core profile completeness', completeFields * 8, 40, `${completeFields} of 5 core profile fields are present.`),
    component('structured_application', 'Structured application', structured ? 20 : categories.length ? 10 : 0, 20, structured ? 'Business categories and sales channels are supplied.' : 'Business classification is incomplete.'),
    component('order_summary', 'Order summary availability', hasOrderSummary ? 25 : 0, 25, hasOrderSummary ? 'An order summary was supplied to the engine.' : 'No order summary was supplied.'),
    component('linked_history', 'Linked history', linkedHistory ? 15 : 0, 15, linkedHistory ? 'Recorded activity is linked to this customer.' : 'No recorded activity is linked.'),
  ];
  const limitations = [];
  if (!hasOrderSummary) limitations.push('Behavioural conclusions are limited without an order summary.');
  if (!linkedHistory) limitations.push('Application statements have not been corroborated by linked purchasing history.');
  return finishScore(components, limitations);
}

function nextBestAction(customer, summary, scores) {
  const approved = Boolean(customer.is_approved);
  const orderCount = positiveNumber(summary.orderCount ?? customer.invoice_count);
  const inactiveDays = daysSince(summary.lastOrderDate || customer.last_purchase_date, summary.now);
  const trend = finiteNumber(summary.salesTrendPercent);

  if (!approved) {
    return { key: 'manual_application_review', label: 'Review application evidence', priority: 'high', reason: 'The application still requires a staff decision.', safeguards: ['Do not approve or decline automatically.', 'Verify any claimed customer code before linking accounts.'] };
  }
  if (!orderCount) {
    return { key: 'support_first_order', label: 'Help with a first order', priority: 'medium', reason: 'The account is approved but no recorded order is linked.', safeguards: ['Confirm the customer wants assistance before contacting them.'] };
  }
  if (inactiveDays !== null && inactiveDays >= 120) {
    return { key: 'reconnect_inactive', label: 'Review for a helpful reconnection', priority: 'high', reason: `The last recorded order was ${inactiveDays} days ago.`, safeguards: ['Review their usual categories before contact.', 'Respect communication preferences.'] };
  }
  if (trend !== null && trend <= -20) {
    return { key: 'understand_decline', label: 'Understand the sales decline', priority: 'high', reason: `Recorded sales are down ${Math.abs(trend)}%.`, safeguards: ['Ask before assuming why purchasing changed.'] };
  }
  if (scores.customerPotential.score >= 70 && scores.engagementHealth.score >= 60) {
    return { key: 'deepen_relationship', label: 'Make the next interaction more relevant', priority: 'medium', reason: 'Recorded potential and engagement signals are both strong.', safeguards: ['Use known categories; do not infer sensitive traits.'] };
  }
  if (scores.dataConfidence.score < 50) {
    return { key: 'complete_customer_record', label: 'Complete the customer record', priority: 'low', reason: 'Available data is too limited for a confident commercial recommendation.', safeguards: ['Ask only for information needed to serve the customer.'] };
  }
  return { key: 'monitor', label: 'No immediate action needed', priority: 'low', reason: 'No clear attention signal is present in the supplied evidence.', safeguards: ['Reassess when new orders or staff notes are recorded.'] };
}

export function buildCustomerIntelligence({ customer = {}, orderSummary = {}, now = new Date().toISOString() } = {}) {
  const summary = { ...orderSummary, now };
  const scores = {
    traderConfidence: traderConfidence(customer, summary),
    customerPotential: customerPotential(customer, summary),
    engagementHealth: engagementHealth(customer, summary, now),
    dataConfidence: dataConfidence(customer, summary),
  };

  return {
    contractVersion: CUSTOMER_INTELLIGENCE_VERSION,
    generatedAt: validDate(now)?.toISOString() || null,
    scores,
    nextBestAction: nextBestAction(customer, summary, scores),
    decisionSafety: {
      automatedApproval: false,
      humanReviewRequired: true,
      statement: 'Customer Intelligence is a deterministic staff aid. It never approves, declines, contacts or changes a customer.',
    },
    evidenceScope: {
      customerApplicationIncluded: Object.keys(customer).length > 0,
      orderSummaryIncluded: Object.keys(orderSummary).length > 0,
      limitations: [
        'Scores reflect only fields supplied to this engine.',
        'No web, social-media, credit or demographic inference is performed.',
      ],
    },
  };
}
