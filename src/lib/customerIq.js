const DAY_MS = 24 * 60 * 60 * 1000;

export const CUSTOMER_IQ_CONTRACT_VERSION = 'customer-iq.v2';

// The imported Positill customer summary currently represents Proto's
// 2025/26 financial year, not a rolling 12-month window. Keep this metadata
// explicit until dated invoice-level customer history is connected.
export const POSITILL_CUSTOMER_SALES_PERIOD = Object.freeze({
  label: '2025/26 financial year',
  shortLabel: '2025/26 FY',
  start: '1 Jul 2025',
  end: '30 Jun 2026',
  taxBasis: 'incl. VAT',
});

function text(value) {
  return String(value ?? '').trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const item = text(value);
  return item ? [item] : [];
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function daysBetween(start, end) {
  const from = dateValue(start);
  const to = dateValue(end);
  if (!from || !to) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}

export function median(values) {
  const clean = values.map(number).filter((value) => value > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function orderItems(order = {}) {
  if (Array.isArray(order.final_items) && order.final_items.length) return order.final_items;
  if (Array.isArray(order.original_items) && order.original_items.length) return order.original_items;
  return Array.isArray(order.items) ? order.items : [];
}

function itemIdentity(item = {}) {
  const sku = text(item.code || item.sku || item.productId || item.product_id || item.barcode);
  const name = text(item.name || item.productName || item.description || item.title) || sku || 'Unnamed product';
  return { key: sku || name.toLowerCase(), sku, name };
}

function itemQuantity(item = {}) {
  return Math.max(0, number(item.finalQty ?? item.qty ?? item.quantity));
}

function orderAmount(order = {}) {
  const stored = number(order.total_ex_vat);
  if (stored > 0) return stored;
  return orderItems(order).reduce((sum, item) => {
    const price = number(item.unitPrice ?? item.price ?? item.unit_price);
    return sum + itemQuantity(item) * price;
  }, 0);
}

function buildReorderProducts(orders) {
  const products = new Map();
  for (const order of orders) {
    const boughtAt = dateValue(order.created_at);
    const seenInOrder = new Set();
    for (const item of orderItems(order)) {
      const identity = itemIdentity(item);
      if (!identity.key || seenInOrder.has(identity.key)) continue;
      seenInOrder.add(identity.key);
      const current = products.get(identity.key) || { ...identity, orderCount: 0, quantities: [], lastPurchased: null };
      current.orderCount += 1;
      const quantity = itemQuantity(item);
      if (quantity > 0) current.quantities.push(quantity);
      if (boughtAt && (!current.lastPurchased || boughtAt > current.lastPurchased)) current.lastPurchased = boughtAt;
      products.set(identity.key, current);
    }
  }

  return [...products.values()]
    .filter((product) => product.orderCount >= 2)
    .map((product) => ({
      sku: product.sku,
      name: product.name,
      orderCount: product.orderCount,
      typicalQuantity: median(product.quantities),
      lastPurchased: product.lastPurchased?.toISOString() || null,
    }))
    .sort((a, b) => b.orderCount - a.orderCount || String(b.lastPurchased).localeCompare(String(a.lastPurchased)))
    .slice(0, 5);
}

function statusFor({ approved, orderCount, daysSinceOrder, rhythmDays, hasPositillSummary }) {
  if (!approved) {
    return { key: 'application_review', label: 'Application review', tone: 'review', explanation: 'This customer is still awaiting a staff decision.' };
  }
  if (!orderCount && !hasPositillSummary) {
    return { key: 'first_order', label: 'First order opportunity', tone: 'opportunity', explanation: 'No portal order is recorded yet.' };
  }
  if (daysSinceOrder == null) {
    return { key: 'limited', label: 'Limited history', tone: 'neutral', explanation: 'Current account totals are available, but recent order dates are incomplete.' };
  }
  if (daysSinceOrder >= Math.max(120, rhythmDays ? rhythmDays * 3 : 120)) {
    return { key: 'dormant', label: 'Dormant', tone: 'attention', explanation: `The last recorded order was ${daysSinceOrder} days ago.` };
  }
  if (rhythmDays && daysSinceOrder > rhythmDays * 1.25) {
    return { key: 'reorder_due', label: 'Reorder may be due', tone: 'attention', explanation: `Their recent ordering rhythm is about ${Math.round(rhythmDays)} days.` };
  }
  if (daysSinceOrder <= 60) {
    return { key: 'active', label: 'Active', tone: 'positive', explanation: 'A recent order is recorded within the last 60 days.' };
  }
  return { key: 'monitor', label: 'Monitor', tone: 'neutral', explanation: `The last recorded order was ${daysSinceOrder} days ago.` };
}

export function buildCustomerIq({ customer = {}, orders = [], totalOrders, source = 'portal', now = new Date().toISOString() } = {}) {
  const datedOrders = orders
    .map((order) => ({ ...order, _date: dateValue(order.created_at) }))
    .filter((order) => order._date)
    .sort((a, b) => b._date - a._date);
  const intervals = [];
  for (let index = 0; index < datedOrders.length - 1; index += 1) {
    const interval = daysBetween(datedOrders[index + 1]._date, datedOrders[index]._date);
    if (interval > 0) intervals.push(interval);
  }

  const assignedCode = text(customer.customer_code || customer.account_code);
  const visibleOrderCount = datedOrders.length;
  const recordedOrderCount = Number.isFinite(Number(totalOrders)) ? Number(totalOrders) : visibleOrderCount;
  const positillInvoiceCount = number(customer.invoice_count);
  const hasPositillSummary = source === 'proto-active' || positillInvoiceCount > 0 || number(customer.sales_last_12_months) > 0;
  const lastOrder = datedOrders[0]?._date || dateValue(customer.last_purchase_date);
  const daysSinceOrder = lastOrder ? daysBetween(lastOrder, now) : null;
  const rhythmDays = median(intervals);
  const portalSpend = datedOrders.reduce((sum, order) => sum + orderAmount(order), 0);
  const status = statusFor({
    approved: Boolean(customer.is_approved || source === 'proto-active'),
    orderCount: Math.max(recordedOrderCount, positillInvoiceCount),
    daysSinceOrder,
    rhythmDays,
    hasPositillSummary,
  });

  const salesChannels = list(customer.sales_channels);
  const productCategories = list(customer.product_categories);
  const businessDescription = text(customer.business_description);
  const signals = [];

  if (salesChannels.length || productCategories.length || businessDescription) {
    signals.push({
      key: 'business_fit',
      label: 'Stated business fit',
      detail: [
        salesChannels.length ? `Trades through ${salesChannels.join(', ')}` : '',
        productCategories.length ? `Interested in ${productCategories.join(', ')}` : '',
      ].filter(Boolean).join(' · ') || businessDescription,
      source: 'Online application',
      tone: 'fact',
    });
  }
  if (businessDescription) {
    signals.push({
      key: 'customer_words',
      label: 'Customer context in their own words',
      detail: businessDescription,
      source: 'Online application · Customer supplied',
      tone: 'fact',
    });
  }

  if (status.key === 'first_order') {
    signals.push({ key: 'next_step', label: 'Suggested staff action', detail: 'Check whether they need help finding stock or placing their first portal order.', source: 'Portal order history', tone: 'opportunity' });
  } else if (status.key === 'reorder_due' || status.key === 'dormant') {
    signals.push({ key: 'next_step', label: 'Suggested staff action', detail: 'Review their usual products and confirm whether a helpful follow-up is appropriate.', source: 'Recorded order dates', tone: 'attention' });
  } else if (status.key === 'active') {
    signals.push({ key: 'next_step', label: 'Suggested staff action', detail: 'Use their stated categories and repeat products to make the next interaction more relevant.', source: 'Application and order history', tone: 'opportunity' });
  }

  const claimedCode = text(customer.claimed_customer_code);
  if (claimedCode && claimedCode !== assignedCode) {
    signals.push({ key: 'claimed_code', label: 'Previous code needs reconciliation', detail: `${claimedCode} was supplied by the applicant. Do not use it as an account match until staff verify it.`, source: 'Online application', tone: 'attention' });
  }

  const dataSources = [];
  if (source === 'proto-active' || hasPositillSummary) dataSources.push('Imported Positill summary');
  if (source !== 'proto-active') dataSources.push(`Portal orders (${visibleOrderCount} loaded)`);
  if (salesChannels.length || productCategories.length || businessDescription) dataSources.push('Online application');

  return {
    contractVersion: CUSTOMER_IQ_CONTRACT_VERSION,
    generatedAt: new Date(now).toISOString(),
    customer: {
      name: text(customer.business_name || customer.name) || 'Unnamed customer',
      assignedCode,
    },
    status,
    metrics: {
      recordedOrderCount: hasPositillSummary && positillInvoiceCount ? positillInvoiceCount : recordedOrderCount,
      orderCountLabel: hasPositillSummary && positillInvoiceCount ? `${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} invoices` : 'Portal orders',
      lastOrder: lastOrder?.toISOString() || null,
      daysSinceOrder,
      rhythmDays,
      spend: hasPositillSummary ? number(customer.sales_last_12_months) : portalSpend,
      spendLabel: hasPositillSummary ? `${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} sales (${POSITILL_CUSTOMER_SALES_PERIOD.taxBasis})` : `Visible portal spend${recordedOrderCount > visibleOrderCount ? ' (partial)' : ''}`,
      salesPeriod: hasPositillSummary ? POSITILL_CUSTOMER_SALES_PERIOD : null,
    },
    application: { salesChannels, productCategories, businessDescription },
    reorderProducts: buildReorderProducts(datedOrders),
    signals,
    evidence: {
      sources: dataSources,
      partial: recordedOrderCount > visibleOrderCount,
      note: 'Deterministic staff aid. Verify evidence before contacting the customer; no action is automated.',
    },
  };
}
