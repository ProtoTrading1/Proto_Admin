function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const EXCLUDED_ORDER_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'deleted', 'void', 'voided', 'failed']);

export function isIncludedOrder(order) {
  return !EXCLUDED_ORDER_STATUSES.has(String(order?.status || '').trim().toLowerCase());
}

export function orderLineQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  return finitePositive(item.qty ?? item.quantity);
}

export function orderUnits(order) {
  const raw = order?.final_items || order?.original_items || order?.items || [];
  if (!Array.isArray(raw)) return 0;
  return raw.reduce((total, item) => total + orderLineQuantity(item), 0);
}

export function rankCustomersByUnits(orders, { limit = 50 } = {}) {
  const rows = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!isIncludedOrder(order)) continue;
    const customerId = String(order?.customer_id || '').trim();
    if (!customerId) continue;
    const customer = order?.customers || {};
    const companyName = String(customer.business_name || customer.name || 'Unknown customer').trim();
    const row = rows.get(customerId) || {
      customerId,
      companyName,
      orders: 0,
      units: 0,
      spendExVat: 0,
    };
    row.orders += 1;
    row.units += orderUnits(order);
    row.spendExVat += finitePositive(order.total_ex_vat);
    if (row.companyName === 'Unknown customer' && companyName !== 'Unknown customer') row.companyName = companyName;
    rows.set(customerId, row);
  }
  return [...rows.values()]
    .filter((row) => row.units > 0)
    .sort((a, b) => b.units - a.units
      || b.spendExVat - a.spendExVat
      || b.orders - a.orders
      || a.companyName.localeCompare(b.companyName)
      || a.customerId.localeCompare(b.customerId))
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function weekToDateWindow(now = new Date()) {
  const end = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(end.getTime())) throw new Error('A valid current time is required.');
  const southAfricaOffset = 2 * 60 * 60 * 1000;
  const local = new Date(end.getTime() + southAfricaOffset);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  local.setUTCHours(0, 0, 0, 0);
  return {
    from: new Date(local.getTime() - southAfricaOffset).toISOString(),
    to: end.toISOString(),
    timezone: 'Africa/Johannesburg',
    label: 'This week',
  };
}

export function rollingWindow(periodDays, now = new Date()) {
  const days = [1, 7, 30, 90].includes(Number(periodDays)) ? Number(periodDays) : 30;
  const end = now instanceof Date ? new Date(now) : new Date(now);
  if (Number.isNaN(end.getTime())) throw new Error('A valid current time is required.');
  return {
    from: new Date(end.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: end.toISOString(),
    timezone: 'Africa/Johannesburg',
    label: days === 1 ? 'Last 24 hours' : `Last ${days} days`,
    periodDays: days,
  };
}

export function publicBuyerRanking(orders, window) {
  const leaders = rankCustomersByUnits(orders, { limit: 3 }).map((row) => ({
    displayName: row.companyName,
    units: row.units,
    orders: row.orders,
    valueExVat: row.spendExVat,
  }));
  return {
    kind: 'customer_order_leader',
    metric: 'units_ordered',
    basis: 'submitted_online_orders',
    window,
    leaders,
    source: { complete: true },
  };
}
