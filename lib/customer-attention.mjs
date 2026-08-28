function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(86400, Math.round(n))) : 0;
}

function latest(a, b) {
  return !a || String(b || '') > String(a) ? (b || a) : a;
}

export function summariseCustomerAttention(rows = [], customers = []) {
  const validRows = rows.filter((row) => ['product', 'category'].includes(row?.content_type) && row?.entity_id);
  const customerMap = new Map(customers.map((customer) => [String(customer.id), customer]));
  const products = new Map();
  const categories = new Map();
  const details = new Map();

  validRows.forEach((row) => {
    const duration = seconds(row.active_seconds);
    const customerId = String(row.customer_id || '');
    const bucket = row.content_type === 'product' ? products : categories;
    const key = String(row.entity_id);
    const summary = bucket.get(key) || {
      id: key,
      label: String(row.entity_label || key),
      views: 0,
      activeSeconds: 0,
      customerIds: new Set(),
      lastSeenAt: null,
    };
    summary.views += 1;
    summary.activeSeconds += duration;
    if (customerId) summary.customerIds.add(customerId);
    summary.lastSeenAt = latest(summary.lastSeenAt, row.last_seen_at);
    bucket.set(key, summary);

    if (customerId) {
      const detailKey = `${customerId}:${row.content_type}:${key}`;
      const detail = details.get(detailKey) || {
        customerId,
        contentType: row.content_type,
        entityId: key,
        entityLabel: String(row.entity_label || key),
        views: 0,
        activeSeconds: 0,
        lastSeenAt: null,
      };
      detail.views += 1;
      detail.activeSeconds += duration;
      detail.lastSeenAt = latest(detail.lastSeenAt, row.last_seen_at);
      details.set(detailKey, detail);
    }
  });

  const finish = (map) => [...map.values()]
    .map((row) => ({
      id: row.id,
      label: row.label,
      views: row.views,
      customers: row.customerIds.size,
      activeSeconds: row.activeSeconds,
      averageSeconds: row.views ? Math.round(row.activeSeconds / row.views) : 0,
      lastSeenAt: row.lastSeenAt,
    }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds || b.views - a.views);

  const customerRows = [...details.values()].map((row) => {
    const customer = customerMap.get(row.customerId) || {};
    return {
      ...row,
      customerName: customer.name || customer.contact_name || customer.email || 'Unknown customer',
      companyName: customer.business_name || '',
      email: customer.email || '',
    };
  }).sort((a, b) => b.activeSeconds - a.activeSeconds || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

  const productRows = finish(products);
  const categoryRows = finish(categories);
  return {
    totalViews: validRows.length,
    totalActiveSeconds: validRows.reduce((sum, row) => sum + seconds(row.active_seconds), 0),
    productsViewed: productRows.length,
    categoriesViewed: categoryRows.length,
    customers: new Set(validRows.map((row) => row.customer_id).filter(Boolean)).size,
    products: productRows,
    categories: categoryRows,
    customerRows,
  };
}
