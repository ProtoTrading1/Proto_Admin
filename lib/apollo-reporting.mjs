import { normalizeOrderStatus } from '../api/_order-status.js';

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dateOnly(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw fail('INVALID_WINDOW', 'Date must be YYYY-MM-DD');
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw fail('INVALID_WINDOW', 'Invalid date');
  return text;
}

function sastDayStart(value) {
  const day = dateOnly(value);
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - SAST_OFFSET_MS);
}

export function reportingWindow(kind = 'day', { now = new Date(), start, end } = {}) {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) throw fail('INVALID_WINDOW', 'Invalid now value');
  const sastNow = new Date(current.getTime() + SAST_OFFSET_MS);
  const day = sastNow.toISOString().slice(0, 10);
  if (kind === 'custom') {
    const from = sastDayStart(start);
    const to = new Date(sastDayStart(end).getTime() + DAY_MS);
    if (to <= from) throw fail('INVALID_WINDOW', 'end must be on or after start');
    return { kind, start: from.toISOString(), end: to.toISOString(), timezone: 'Africa/Johannesburg', periodToDate: false };
  }
  if (!['day', 'week', 'month'].includes(kind)) throw fail('INVALID_WINDOW', `Unknown window: ${kind}`);
  const date = new Date(`${day}T00:00:00.000Z`);
  let from = date; let to = new Date(date.getTime() + DAY_MS);
  if (kind === 'week') { from = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS); to = new Date(from.getTime() + 7 * DAY_MS); }
  if (kind === 'month') { from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)); }
  const startMs = from.getTime() - SAST_OFFSET_MS;
  const endMs = Math.max(startMs + 1, Math.min(to.getTime() - SAST_OFFSET_MS, current.getTime()));
  return { kind, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), timezone: 'Africa/Johannesburg', periodToDate: true };
}

export function previousReportingWindow(window) {
  if (!window || !['day', 'week', 'month', 'custom'].includes(window.kind)) throw fail('INVALID_WINDOW', 'A valid reporting window is required');
  const start = asWindowTimestamp(window.start, 'window start');
  const end = asWindowTimestamp(window.end, 'window end');
  if (end <= start) throw fail('INVALID_WINDOW', 'end must be after start');
  let previousStart;
  let previousEnd;
  if (window.kind === 'month') {
    const sastStart = new Date(start + SAST_OFFSET_MS);
    previousStart = Date.UTC(sastStart.getUTCFullYear(), sastStart.getUTCMonth() - 1, 1) - SAST_OFFSET_MS;
    const previousPeriodEnd = Date.UTC(sastStart.getUTCFullYear(), sastStart.getUTCMonth(), 1) - SAST_OFFSET_MS;
    previousEnd = Math.min(previousStart + (end - start), previousPeriodEnd);
  } else if (window.periodToDate && (window.kind === 'day' || window.kind === 'week')) {
    // Compare matching elapsed portions of the prior calendar day/week, not
    // the equal-length interval immediately before the current window.
    const offset = window.kind === 'day' ? DAY_MS : 7 * DAY_MS;
    previousStart = start - offset;
    previousEnd = end - offset;
  } else {
    previousStart = start - (end - start);
    previousEnd = start;
  }
  return { kind: window.kind, start: new Date(previousStart).toISOString(), end: new Date(previousEnd).toISOString(), timezone: 'Africa/Johannesburg', periodToDate: false,
    comparisonBasis: window.periodToDate ? 'matching_period_to_date' : 'previous_equal_duration' };
}

function asWindowTimestamp(value, label) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw fail('INVALID_WINDOW', `${label} requires an explicit timezone`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw fail('INVALID_WINDOW', `Invalid ${label}`);
  return parsed;
}

export function evidenceEnvelope({ value, source, taxBasis = null, window = null, warnings = [], generatedAt = null, lastSuccessfulAt = null, complete = false } = {}) {
  return { value: value ?? null, known: value !== null && value !== undefined, source: source || 'unknown', taxBasis, window, warnings: [...warnings], generatedAt, lastSuccessfulAt, complete: Boolean(complete) };
}

export async function paginateSelect({ selectPage, pageSize = 1000, maxRows = 10000 } = {}) {
  if (typeof selectPage !== 'function') throw fail('INVALID_PAGINATION', 'selectPage is required');
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxRows) || maxRows < pageSize) throw fail('INVALID_PAGINATION', 'Invalid pagination bounds');
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const result = await selectPage({ from, to: Math.min(from + pageSize, maxRows) - 1 });
    if (result?.error) throw fail('SELECT_FAILED', result.error.message || String(result.error));
    const page = Array.isArray(result) ? result : result?.data;
    const requested = Math.min(pageSize, maxRows - from);
    if (!Array.isArray(page) || page.length > requested) throw fail('INVALID_PAGE', 'Missing or oversized result page');
    rows.push(...page);
    if (page.length < requested) return rows;
  }
  throw fail('PAGINATION_CAP_EXCEEDED', `Read-only select exceeded cap of ${maxRows} rows`);
}

function itemKey(item = {}) {
  return String(item?.variant_sku ?? item?.variantSku ?? item?.sku ?? item?.code ?? item?.product?.sku ?? item?.product?.code ?? item?.productId ?? item?.product_id ?? item?.product?.id ?? '').trim();
}

function numeric(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function aggregateWebsiteOrders(orders = []) {
  const result = { orders: 0, revenue: null, revenueKnown: true, discountsInclVat: 0, statuses: {}, products: [], productsComplete: true, statusContractComplete: true, unknownStatusOrders: 0, complete: true, taxBasis: 'incl_vat', cancelledOrders: 0 };
  let revenue = 0;
  const products = new Map();
  for (const order of orders) {
    result.orders += 1;
    const rawStatus = String(order.status ?? 'pending').trim().toLowerCase() || 'pending';
    const cancelled = /cancel|void|reject|trash/.test(rawStatus);
    const knownStatus = cancelled || ['pending', 'viewed', 'handed over', 'order in progress', 'order sent', 'payment received', 'awaiting payment', 'paid', 'delivered'].includes(rawStatus);
    if (!knownStatus) {
      result.statuses.unrecognized = (result.statuses.unrecognized || 0) + 1;
      result.statusContractComplete = false;
      result.unknownStatusOrders += 1;
      result.revenueKnown = false;
      result.productsComplete = false;
      continue;
    }
    const status = cancelled ? 'cancelled' : normalizeOrderStatus(rawStatus);
    result.statuses[status] = (result.statuses[status] || 0) + 1;
    if (status === 'cancelled') { result.cancelledOrders += 1; continue; }
    const orderSubtotal = numeric(order.total_ex_vat);
    const discount = order.discount_amount == null ? 0 : numeric(order.discount_amount);
    if (orderSubtotal === null || orderSubtotal < 0 || discount === null || discount < 0) result.revenueKnown = false;
    else {
      // Despite its legacy name, total_ex_vat stores the VAT-inclusive
      // storefront subtotal. Customer-facing totals subtract the recorded
      // VAT-inclusive promo discount and never fall below zero.
      const boundedDiscount = Math.min(discount, Math.max(0, orderSubtotal));
      result.discountsInclVat += boundedDiscount;
      revenue += Math.max(0, orderSubtotal - boundedDiscount);
    }
    const items = Array.isArray(order.final_items) ? order.final_items : (Array.isArray(order.original_items) ? order.original_items : (Array.isArray(order.items) ? order.items : null));
    if (!items) { result.productsComplete = false; continue; }
    for (const item of items) {
      const key = itemKey(item);
      const units = numeric(item?.finalQty ?? item?.qty ?? item?.quantity);
      if (!key || units === null || units < 0) { result.productsComplete = false; continue; }
      const row = products.get(key) || { key, parentKey: String(item?.parent_sku ?? item?.parentSku ?? item?.parent_product_id ?? item?.parentProductId ?? item?.product?.parentSku ?? '').trim() || null, units: 0, value: 0, valueKnown: true };
      const price = numeric(item?.unitPrice ?? item?.price ?? item?.unit_price ?? item?.product?.price);
      row.units += units;
      if (price === null) row.valueKnown = false;
      else row.value += units * price;
      products.set(key, row);
    }
  }
  if (result.revenueKnown) result.revenue = revenue;
  result.products = [...products.values()].map(row => ({ ...row, value: row.valueKnown ? Math.round(row.value * 100) / 100 : null }))
    .sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
  if (result.revenue !== null) result.revenue = Math.round(result.revenue * 100) / 100;
  result.discountsInclVat = Math.round(result.discountsInclVat * 100) / 100;
  result.complete = result.revenueKnown && result.productsComplete && result.statusContractComplete;
  return result;
}

const TAX_BASES = new Set(['incl_vat', 'ex_vat']);

export function normalizePositillRows(rows = [], { taxBasis, typeSigns, amountSignConvention } = {}) {
  if (!TAX_BASES.has(taxBasis)) throw fail('UNKNOWN_TAX_BASIS', 'POS tax basis must be explicitly incl_vat or ex_vat');
  if (!typeSigns || typeof typeSigns !== 'object' || !['as_stored', 'signed_by_mapping'].includes(amountSignConvention)) throw fail('UNKNOWN_POS_SEMANTICS', 'POS type/sign semantics require an explicit verified mapping');
  return rows.map((row) => {
    const type = String(row.type ?? row.invoiceType ?? '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(typeSigns, type) || ![1, -1].includes(typeSigns[type])) throw fail('UNKNOWN_DOCUMENT_TYPE', `Unknown POS document type: ${type || '(missing)'}`);
    const quantity = numeric(row.quantity ?? row.qty);
    const amount = numeric(row.amount ?? row.lineTotal ?? row.total);
    if (quantity === null || amount === null) throw fail('INVALID_POS_VALUE', 'POS quantity and amount must be numeric');
    if (amountSignConvention === 'signed_by_mapping' && (quantity < 0 || amount < 0)) throw fail('INVALID_POS_VALUE', 'Unsigned source convention received negative values');
    if (amountSignConvention === 'as_stored' && (quantity * typeSigns[type] < 0 || amount * typeSigns[type] < 0)) throw fail('INVALID_POS_VALUE', 'Stored sign contradicts verified document type');
    const sign = amountSignConvention === 'signed_by_mapping' ? typeSigns[type] : 1;
    return { ...row, taxBasis, documentType: type, quantity: quantity * sign, amount: amount * sign };
  });
}

export function reconcileByReference(left = [], right = [], { leftRef = 'reference', rightRef = 'reference' } = {}) {
  const map = new Map();
  const leftSeen = new Set();
  for (const row of left) {
    const ref = String(row[leftRef] ?? '').trim();
    if (!ref || leftSeen.has(ref)) throw fail('REFERENCE_RECONCILIATION_FAILED', 'References must be present and unique');
    leftSeen.add(ref);
  }
  for (const row of right) {
    const ref = String(row[rightRef] ?? '').trim();
    if (!ref || map.has(ref)) throw fail('REFERENCE_RECONCILIATION_FAILED', 'POS references must be present and unique');
    map.set(ref, row);
  }
  return left.map((row) => {
    const ref = String(row[leftRef] ?? '').trim();
    return { reference: ref || null, left: row, right: ref ? (map.get(ref) || null) : null, matched: Boolean(ref && map.has(ref)) };
  });
}

