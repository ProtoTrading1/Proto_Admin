const INSTORE_ROUTES = new Set(['instore-products', 'extended-range']);

export function normalizedSku(value) {
  return String(value || '').trim().toUpperCase();
}

export function isInstorePageView(event) {
  if (event?.event_type !== 'category_view') return false;
  const route = String(event.entity_id || '').trim().toLowerCase().split(/[/?#]/)[0];
  return INSTORE_ROUTES.has(route);
}

export function orderItems(order) {
  for (const field of ['final_items', 'original_items', 'items']) {
    if (Array.isArray(order?.[field]) && order[field].length) return order[field];
  }
  return [];
}

const EXCLUDED_ORDER_STATUSES = new Set(['cancelled', 'canceled', 'refunded', 'rejected']);

function johannesburgDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function summarizeInstoreAnalytics({ products = [], events = [], orders = [], since, asOf }) {
  const productsBySku = new Map(products.map((row) => [normalizedSku(row.sku), row]).filter(([sku]) => sku));
  const viewsBySku = new Map();
  let productViews = 0;
  const daily = new Map();
  const addDaily = (value, field, count = 1) => {
    const day = johannesburgDate(value);
    if (!day) return;
    const row = daily.get(day) || { date: day, productOpens: 0, orders: 0, units: 0 };
    row[field] += count;
    daily.set(day, row);
  };

  for (const event of events) {
    if (event.event_type !== 'product_view') continue;
    const sku = normalizedSku(event.entity_id);
    if (!productsBySku.has(sku)) continue;
    productViews += 1;
    viewsBySku.set(sku, (viewsBySku.get(sku) || 0) + 1);
    addDaily(event.created_at, 'productOpens');
  }

  let ordersWithInstore = 0;
  let unitsOrdered = 0;
  const unitsBySku = new Map();
  for (const order of orders) {
    if (EXCLUDED_ORDER_STATUSES.has(String(order.status || '').trim().toLowerCase())) continue;
    let containsInstore = false;
    let orderUnits = 0;
    for (const item of orderItems(order)) {
      const sku = [item.productId, item.code, item.product?.id, item.product?.code]
        .map(normalizedSku).find((code) => productsBySku.has(code));
      if (!sku) continue;
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      containsInstore = true;
      unitsOrdered += qty;
      orderUnits += qty;
      unitsBySku.set(sku, (unitsBySku.get(sku) || 0) + qty);
    }
    if (containsInstore) {
      ordersWithInstore += 1;
      addDaily(order.created_at, 'orders');
      addDaily(order.created_at, 'units', orderUnits);
    }
  }

  const rankedProducts = [...productsBySku].map(([sku, row]) => ({
    sku,
    title: String(row.title || '').trim() || sku,
    views: viewsBySku.get(sku) || 0,
    unitsOrdered: unitsBySku.get(sku) || 0,
  })).filter((row) => row.views || row.unitsOrdered)
    .sort((a, b) => b.views - a.views || b.unitsOrdered - a.unitsOrdered || a.sku.localeCompare(b.sku));

  const firstDay = since && johannesburgDate(since);
  const lastDay = asOf && johannesburgDate(asOf);
  const days = [];
  if (firstDay && lastDay) {
    for (let cursor = Date.parse(`${firstDay}T00:00:00Z`); cursor <= Date.parse(`${lastDay}T00:00:00Z`); cursor += 86400000) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      days.push(daily.get(date) || { date, productOpens: 0, orders: 0, units: 0 });
    }
  } else {
    days.push(...[...daily.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }

  return { productViews, ordersWithInstore, unitsOrdered, products: rankedProducts, topProducts: rankedProducts.slice(0, 12), days };
}
