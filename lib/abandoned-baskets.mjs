/**
 * Abandoned basket analytics — pure shaping logic.
 *
 * A "basket" here is a row of `customer_account_carts` (portal project,
 * migration 057). The portal keeps exactly one row per approved customer and
 * empties `items` to `[]` when an order is submitted, so **any row that still
 * holds items belongs to a customer who has not checked out**. That invariant
 * is the whole feature: we do not need a separate abandonment tracker.
 *
 * Money note: storefront unit prices are VAT-INCLUSIVE (the portal's
 * `orderVatSummary` documents that `total_ex_vat` is a legacy column name).
 * Every value produced here is therefore incl. VAT, and the UI must say so.
 */

export const VAT_RATE = 15 / 115;

/** A basket touched within this many days is still being actively shopped. */
export const ACTIVE_WITHIN_DAYS = 2;
/** Past this, the basket has gone cold and is worth chasing. */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * Milliseconds for a basket's last activity. `activity_at` is the portal's own
 * epoch stamp and is the truest signal; `updated_at` is the row write time and
 * covers rows written before activity tracking, so it is the fallback.
 */
export function basketActivityMs(row) {
  const activityAt = Number(row?.activity_at);
  if (Number.isSafeInteger(activityAt) && activityAt > 0) return activityAt;
  const updated = Date.parse(row?.updated_at || '');
  return Number.isFinite(updated) ? updated : null;
}

/** One basket line, defensive against half-written product snapshots. */
export function normaliseLine(raw) {
  const product = raw && typeof raw === 'object' ? raw.product : null;
  if (!product || typeof product !== 'object') return null;

  const qty = positiveInt(raw.qty);
  if (!qty) return null;

  const price = Math.max(0, finiteNumber(product.price));
  const sku = text(product.sku) || text(product.id) || text(product.code);
  if (!sku) return null;

  return {
    sku,
    code: text(product.code) || sku,
    name: text(product.name) || sku,
    image: text(product.image) || text(product.localImage),
    qty,
    price,
    lineTotal: price * qty,
    inStock: product.inStock !== false,
    toOrder: product.toOrder === true || product.to_order === true,
  };
}

/** Lines + money for a single cart row. Returns null when nothing is left. */
export function summariseBasket(row) {
  const rawItems = Array.isArray(row?.items) ? row.items : [];
  const items = rawItems.map(normaliseLine).filter(Boolean);
  if (!items.length) return null;

  const value = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    items,
    lineCount: items.length,
    totalQty: items.reduce((sum, item) => sum + item.qty, 0),
    value,
    outOfStockLines: items.filter((item) => !item.inStock).length,
  };
}

export function basketAgeDays(activityMs, now) {
  if (!Number.isFinite(activityMs)) return null;
  return Math.max(0, (now - activityMs) / DAY_MS);
}

/**
 * Three buckets, because they call for different action: `active` is still
 * shopping (leave alone), `cooling` has paused, `stale` needs a nudge.
 */
export function stalenessBucket(ageDays) {
  if (ageDays === null) return 'unknown';
  if (ageDays <= ACTIVE_WITHIN_DAYS) return 'active';
  if (ageDays <= STALE_AFTER_DAYS) return 'cooling';
  return 'stale';
}

function customerDetail(customer) {
  if (!customer) {
    return {
      name: 'Unknown customer',
      businessName: '',
      email: '',
      phone: '',
      customerCode: '',
      tier: '',
      city: '',
      province: '',
      tags: [],
      isApproved: false,
      salesLast12Months: null,
      lastPurchaseDate: null,
      lastEmailType: '',
      lastEmailAt: null,
      customerSince: null,
      missing: true,
    };
  }

  const name = text(customer.name)
    || text(customer.contact_name)
    || text(customer.first_name)
    || text(customer.business_name)
    || text(customer.email)
    || 'Unknown customer';

  return {
    name,
    businessName: text(customer.business_name),
    email: text(customer.email),
    phone: text(customer.phone),
    customerCode: text(customer.customer_code),
    tier: text(customer.tier),
    city: text(customer.city),
    province: text(customer.province),
    tags: Array.isArray(customer.tags) ? customer.tags.filter(Boolean).map(String) : [],
    isApproved: customer.is_approved === true,
    salesLast12Months: Number.isFinite(Number(customer.sales_last_12_months))
      ? Number(customer.sales_last_12_months)
      : null,
    lastPurchaseDate: customer.last_purchase_date || null,
    lastEmailType: text(customer.last_email_type),
    lastEmailAt: customer.last_email_at || null,
    customerSince: customer.created_at || null,
    missing: false,
  };
}

/**
 * Join cart rows to customer records and drop everything that is not an
 * outstanding basket. Rows whose customer has vanished are still returned —
 * an orphaned basket is a data problem worth seeing, not worth hiding.
 */
export function buildAbandonedBaskets({ carts = [], customers = [], now = Date.now() } = {}) {
  const byId = new Map();
  customers.forEach((customer) => {
    if (customer?.id) byId.set(String(customer.id), customer);
  });

  return carts.reduce((rows, row) => {
    const totals = summariseBasket(row);
    if (!totals) return rows;

    const customerId = String(row?.customer_id || '');
    const activityMs = basketActivityMs(row);
    const ageDays = basketAgeDays(activityMs, now);

    rows.push({
      customerId,
      ...customerDetail(byId.get(customerId)),
      ...totals,
      lastActivityAt: Number.isFinite(activityMs) ? new Date(activityMs).toISOString() : null,
      ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
      staleness: stalenessBucket(ageDays),
    });
    return rows;
  }, []);
}

export function summariseBaskets(baskets = []) {
  const values = baskets.map((basket) => basket.value);
  const totalValue = values.reduce((sum, value) => sum + value, 0);
  const countBucket = (bucket) => baskets.filter((basket) => basket.staleness === bucket).length;

  return {
    basketCount: baskets.length,
    totalValue,
    vatIncluded: totalValue * VAT_RATE,
    avgValue: baskets.length ? totalValue / baskets.length : 0,
    biggestValue: values.length ? Math.max(...values) : 0,
    totalLines: baskets.reduce((sum, basket) => sum + basket.lineCount, 0),
    totalUnits: baskets.reduce((sum, basket) => sum + basket.totalQty, 0),
    activeCount: countBucket('active'),
    coolingCount: countBucket('cooling'),
    staleCount: countBucket('stale'),
    // Who we could actually chase, if outreach is added later.
    contactableCount: baskets.filter((basket) => basket.email).length,
    withOutOfStockCount: baskets.filter((basket) => basket.outOfStockLines > 0).length,
  };
}

const SORTS = {
  value: (a, b) => b.value - a.value,
  recent: (a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''),
  oldest: (a, b) => (a.lastActivityAt || '').localeCompare(b.lastActivityAt || ''),
  lines: (a, b) => b.lineCount - a.lineCount,
  name: (a, b) => a.name.localeCompare(b.name),
};

export const SORT_KEYS = Object.keys(SORTS);

export function sortBaskets(baskets = [], sort = 'value') {
  const comparator = SORTS[sort] || SORTS.value;
  // Value break-ties keep the order stable and useful rather than arbitrary.
  return [...baskets].sort((a, b) => comparator(a, b) || b.value - a.value);
}

/** Free-text match across the customer detail an admin would search by. */
export function filterBaskets(baskets = [], { staleness = 'all', search = '' } = {}) {
  const needle = text(search).toLowerCase();
  return baskets.filter((basket) => {
    if (staleness !== 'all' && basket.staleness !== staleness) return false;
    if (!needle) return true;
    return [
      basket.name,
      basket.businessName,
      basket.email,
      basket.phone,
      basket.customerCode,
      ...basket.items.map((item) => item.name),
      ...basket.items.map((item) => item.sku),
    ].some((field) => String(field || '').toLowerCase().includes(needle));
  });
}

/** Flat rows for CSV/Excel export — one line per basket line. */
export function basketExportRows(baskets = []) {
  return baskets.flatMap((basket) => basket.items.map((item) => ({
    Customer: basket.name,
    Business: basket.businessName,
    Email: basket.email,
    Phone: basket.phone,
    'Customer code': basket.customerCode,
    'Basket value (incl VAT)': Math.round(basket.value * 100) / 100,
    'Basket lines': basket.lineCount,
    'Last activity': basket.lastActivityAt || '',
    'Days idle': basket.ageDays === null ? '' : basket.ageDays,
    Status: basket.staleness,
    SKU: item.sku,
    Product: item.name,
    Qty: item.qty,
    'Unit price (incl VAT)': item.price,
    'Line total (incl VAT)': Math.round(item.lineTotal * 100) / 100,
    'In stock': item.inStock ? 'Yes' : 'No',
  })));
}
