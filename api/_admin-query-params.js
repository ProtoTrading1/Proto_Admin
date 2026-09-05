const ORDER_TABS = new Set(['all', 'new', 'handed', 'progress', 'sent', 'paid']);
const CUSTOMER_TABS = new Set(['requests', 'on-hold', 'premium', 'regular']);

export function parsePositiveInt(raw, { name, min = 1, max = 200, fallback } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback != null ? fallback : min;
  }
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  if (n < min || n > max) {
    throw new Error(`Invalid ${name}: must be between ${min} and ${max}`);
  }
  return n;
}

export function parseOrderTab(raw) {
  const tab = String(raw || 'all').trim().toLowerCase();
  if (!ORDER_TABS.has(tab)) {
    throw new Error(`Invalid tab: must be one of ${[...ORDER_TABS].join(', ')}`);
  }
  return tab;
}

export function parseCustomerTab(raw) {
  const tab = String(raw || 'requests').trim().toLowerCase();
  if (!CUSTOMER_TABS.has(tab)) {
    throw new Error(`Invalid tab: must be one of ${[...CUSTOMER_TABS].join(', ')}`);
  }
  return tab;
}

export function parseBusinessTypeFilter(raw) {
  const bt = String(raw || '').trim();
  if (!bt) return '';
  if (bt === '__unspecified__') return bt;
  if (bt.length > 120) throw new Error('Invalid business_type: too long');
  return bt;
}
