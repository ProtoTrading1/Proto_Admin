import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeOrderStatus } from './_order-status.js';

const STATUS_LABELS = {
  pending: 'New',
  'handed over': 'Handed Over',
  'order in progress': 'In Progress',
  'order sent': 'Order Confirmation',
  'payment received': 'Payment Received',
};

const VALID_PERIODS = [7, 30, 90, 120];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function getStockClient() {
  const url = process.env.VITE_STOCK_SUPABASE_URL;
  const key = process.env.VITE_STOCK_SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function buildProductCategoryMap(productKeys) {
  const supabase = getStockClient();
  const map = {};
  if (!supabase) return map;

  const ids = [...new Set(productKeys.map((k) => String(k || '').trim()).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from('website_stock')
      .select('sku, category')
      .in('sku', chunk);
    if (error) continue;
    (data || []).forEach((row) => {
      const label = String(row.category || '').trim();
      if (row.sku && label) map[row.sku] = label;
    });
  }
  return map;
}

function resolveCategoryLabel(item, categoryLabels, productCatMap) {
  const fromItem = item.mainCategoryLabel
    || categoryLabels[item.mainCategoryId]
    || categoryLabels[item.categoryId]
    || categoryLabels[item.category];
  if (fromItem) return fromItem;

  const fromStock = productCatMap[item.productId] || productCatMap[item.code];
  if (fromStock) return fromStock;

  return null;
}

function loadCategoryLabels() {
  try {
    const tree = JSON.parse(readFileSync(join(process.cwd(), 'src/data/categories.json'), 'utf8'));
    const map = {};
    tree.forEach((c) => { map[c.id] = c.label; });
    return map;
  } catch {
    return {};
  }
}

function parsePeriod(raw) {
  const n = parseInt(raw, 10);
  return VALID_PERIODS.includes(n) ? n : 30;
}

function inPeriod(dateStr, cutoff) {
  const t = new Date(dateStr).getTime();
  return !Number.isNaN(t) && t >= cutoff.getTime();
}

function orderItems(order) {
  const raw = order.final_items || order.original_items || order.items || [];
  return Array.isArray(raw) ? raw : [];
}

function bucketKey(date, periodDays) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (periodDays <= 30) {
    return d.toISOString().slice(0, 10);
  }
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() - d.getDay());
  return weekStart.toISOString().slice(0, 10);
}

function formatBucketLabel(key, periodDays) {
  const d = new Date(`${key}T12:00:00`);
  if (periodDays <= 30) {
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  }
  return `W/C ${d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  // DELETE — clear all tracked analytics events (product/category views).
  // Order-derived metrics are computed live from the orders table, so they
  // are intentionally untouched here; deleting orders is a separate action.
  if (req.method === 'DELETE') {
    const supabase = getAdminClient();
    const errors = [];
    const { error: eventsErr } = await supabase
      .from('analytics_events')
      .delete()
      .gte('created_at', '1970-01-01');
    if (eventsErr && !/does not exist/i.test(eventsErr.message)) errors.push(eventsErr.message);

    const { error: searchErr } = await supabase
      .from('search_analytics')
      .delete()
      .gte('created_at', '1970-01-01');
    if (searchErr && !/does not exist/i.test(searchErr.message)) errors.push(searchErr.message);

    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).end();

  const periodDays = parsePeriod(req.query.period);
  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const supabase = getAdminClient();
  const categoryLabels = loadCategoryLabels();

  const [ordersRes, customersRes, eventsRes] = await Promise.all([
    supabase.from('orders').select('id, customer_id, status, total_ex_vat, created_at, original_items, final_items, items, customers(name, email)'),
    supabase.from('customers').select('id, name, email, created_at, is_approved'),
    supabase.from('analytics_events').select('event_type, entity_id, entity_label, created_at').gte('created_at', cutoff.toISOString()),
  ]);

  if (ordersRes.error) return res.status(400).json({ error: ordersRes.error.message });
  if (customersRes.error) return res.status(400).json({ error: customersRes.error.message });
  // analytics_events table may not exist yet — treat as empty
  const events = eventsRes.error ? [] : (eventsRes.data || []);

  const allOrders = ordersRes.data || [];
  const orders = allOrders.filter((o) => inPeriod(o.created_at, cutoff));

  const totalRevenue = orders.reduce((s, o) => s + (Number(o.total_ex_vat) || 0), 0);
  const totalOrders = orders.length;
  const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;

  const orderingCustomerIds = new Set(orders.map((o) => o.customer_id).filter(Boolean));
  const customerOrderCounts = {};
  orders.forEach((o) => {
    if (!o.customer_id) return;
    customerOrderCounts[o.customer_id] = (customerOrderCounts[o.customer_id] || 0) + 1;
  });
  const repeatCustomers = Object.values(customerOrderCounts).filter((c) => c > 1).length;
  const repeatCustomerPct = orderingCustomerIds.size
    ? Math.round((repeatCustomers / orderingCustomerIds.size) * 100)
    : 0;

  const timeBuckets = new Map();
  orders.forEach((o) => {
    const key = bucketKey(o.created_at, periodDays);
    if (!key) return;
    const row = timeBuckets.get(key) || { date: key, orders: 0, revenue: 0 };
    row.orders += 1;
    row.revenue += Number(o.total_ex_vat) || 0;
    timeBuckets.set(key, row);
  });
  const ordersOverTime = [...timeBuckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({ ...row, label: formatBucketLabel(row.date, periodDays) }));

  const productKeys = [];
  orders.forEach((order) => {
    orderItems(order).forEach((item) => {
      if (item.productId) productKeys.push(item.productId);
      if (item.code) productKeys.push(item.code);
    });
  });
  const productCatMap = await buildProductCategoryMap(productKeys);

  const productQty = new Map();
  const categoryQty = new Map();
  orders.forEach((order) => {
    orderItems(order).forEach((item) => {
      const code = item.code || item.productId || 'unknown';
      const name = item.name || code;
      const qty = Number(item.qty) || 0;
      if (qty <= 0) return;
      const pKey = code;
      const pRow = productQty.get(pKey) || { code, name, qty: 0, category: resolveCategoryLabel(item, categoryLabels, productCatMap) || '' };
      pRow.qty += qty;
      if (!pRow.category) pRow.category = resolveCategoryLabel(item, categoryLabels, productCatMap) || '';
      productQty.set(pKey, pRow);

      const catLabel = resolveCategoryLabel(item, categoryLabels, productCatMap) || 'Uncategorised';
      const cRow = categoryQty.get(catLabel) || { label: catLabel, qty: 0 };
      cRow.qty += qty;
      categoryQty.set(catLabel, cRow);
    });
  });

  const topOrderedProducts = [...productQty.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);
  const topOrderedCategories = [...categoryQty.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);

  const viewCounts = (type) => {
    const map = new Map();
    events.filter((e) => e.event_type === type).forEach((e) => {
      const label = (e.entity_label || e.entity_id || 'unknown').trim();
      const key = label.toLowerCase();
      const row = map.get(key) || { id: e.entity_id || key, label, views: 0 };
      row.views += 1;
      map.set(key, row);
    });
    return [...map.values()].sort((a, b) => b.views - a.views).slice(0, 10);
  };

  const statusBreakdown = {};
  orders.forEach((o) => {
    const key = normalizeOrderStatus(o.status);
    const label = STATUS_LABELS[key] || key;
    statusBreakdown[label] = (statusBreakdown[label] || 0) + 1;
  });
  const orderStatusBreakdown = Object.entries(statusBreakdown).map(([label, count]) => ({ label, count }));

  const byDay = Array.from({ length: 7 }, (_, i) => ({ day: DAY_LABELS[i], orders: 0 }));
  const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, orders: 0 }));
  orders.forEach((o) => {
    const d = new Date(o.created_at);
    if (Number.isNaN(d.getTime())) return;
    byDay[d.getDay()].orders += 1;
    byHour[d.getHours()].orders += 1;
  });

  const customerSpend = new Map();
  orders.forEach((o) => {
    if (!o.customer_id) return;
    const row = customerSpend.get(o.customer_id) || {
      id: o.customer_id,
      name: o.customers?.name || 'Unknown',
      email: o.customers?.email || '',
      orders: 0,
      spend: 0,
    };
    row.orders += 1;
    row.spend += Number(o.total_ex_vat) || 0;
    customerSpend.set(o.customer_id, row);
  });
  const topCustomers = [...customerSpend.values()].sort((a, b) => b.spend - a.spend || b.orders - a.orders).slice(0, 50);

  const approvedCustomers = (customersRes.data || []).filter((c) => c.is_approved);

  return res.status(200).json({
    periodDays,
    summary: {
      totalOrders,
      totalRevenue,
      avgOrderValue,
      customersWhoOrdered: orderingCustomerIds.size,
      totalApprovedCustomers: approvedCustomers.length,
      repeatCustomerPct,
    },
    ordersOverTime,
    topOrderedProducts,
    topOrderedCategories,
    topViewedProducts: viewCounts('product_view'),
    topViewedCategories: viewCounts('category_view'),
    orderStatusBreakdown,
    peakByDay: byDay,
    peakByHour: byHour,
    topCustomers,
    trackingEnabled: !eventsRes.error,
  });
}
