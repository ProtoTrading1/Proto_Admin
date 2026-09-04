const source = (id, label, section, privacy, keywords, options = {}) => Object.freeze({
  id,
  label,
  section,
  privacy,
  delivery: options.delivery || 'codex_aggregate',
  status: options.status || 'connected',
  roles: Object.freeze(options.roles || ['owner', 'customer_service']),
  keywords: Object.freeze(keywords),
});

/**
 * Apollo's single source of truth. This catalogue contains capabilities only:
 * never credentials, customer data, or database text.
 */
export const APOLLO_SOURCE_CATALOG = Object.freeze([
  source('orders', 'Online orders', 'orders', 'aggregate', ['order', 'orders', 'sales', 'revenue', 'average order', 'repeat customer', 'bought', 'purchased']),
  source('customer_attention', 'Customer attention', 'analytics', 'aggregate', ['view', 'views', 'viewed', 'viewing', 'duration', 'attention', 'customer interest', 'looking at']),
  source('search', 'Website search', 'analytics', 'aggregate', ['search', 'searches', 'searched', 'searching', 'no result', 'zero result']),
  source('baskets', 'Outstanding baskets', 'analytics', 'aggregate', ['basket', 'baskets', 'abandoned cart', 'checkout']),
  source('backend_health', 'Backend health', 'backend-health', 'operational', ['health', 'healthy', 'system', 'backend', 'bridge', 'database', 'vercel', 'service', 'offline', 'down', 'connection']),
  source('image_processing', 'Image processing', 'image-processing', 'operational', ['image', 'images', 'photo', 'photos', 'processing queue']),
  source('product_intelligence', 'Product intelligence', 'product-intelligence', 'local_record', ['sku', 'barcode', 'stock', 'price', 'positill'], { delivery: 'deterministic_local' }),
  source('catalogue', 'Live catalogue', 'catalogue', 'aggregate', ['catalogue', 'catalog', 'live products', 'uncategorized', 'product count']),
  source('archive', 'Product archive', 'archive', 'aggregate', ['archive', 'archived', 'new image items', 'recycle bin', 'approval pending']),
  source('customers', 'Customer base', 'customers', 'aggregate', ['customer base', 'customer count', 'how many customers', 'account count']),
  source('crm', 'Customer communications', 'comms', 'aggregate', ['campaign', 'campaigns', 'email performance', 'delivered', 'opened', 'clicked', 'bounced', 'communications', 'comms']),
  source('site_content', 'Website content', 'site-content', 'aggregate', ['featured', 'specials', 'banner', 'site content', 'homepage', 'home page']),
  source('product_loader', 'Product Loader audit', 'product-loader', 'aggregate', ['product loader', 'published products', 'publish history', 'loader audit']),
  source('fulfillment', 'Order workflow', 'orders', 'aggregate', ['fulfillment', 'fulfilment', 'handed over', 'in progress', 'order sent', 'payment received', 'workflow']),
  source('pricing', 'Pricing review', 'pricing', 'aggregate', ['pricing review', 'price health', 'mispriced', 'price discrepancy'], { status: 'planned', roles: ['owner'] }),
  source('buying', 'Buying workspace', 'buying', 'aggregate', ['buying', 'supplier', 'purchase order', 'replenishment'], { status: 'planned', roles: ['owner'] }),
  source('team', 'Team access', 'team', 'metadata', ['team', 'staff access', 'admin users', 'permissions'], { delivery: 'deterministic_local', status: 'planned', roles: ['owner'] }),
]);

export const APOLLO_SOURCE_IDS = Object.freeze(APOLLO_SOURCE_CATALOG.map((item) => item.id));
export const APOLLO_CONNECTED_SOURCE_IDS = Object.freeze(APOLLO_SOURCE_CATALOG.filter((item) => item.status === 'connected').map((item) => item.id));

export function getApolloSource(id) {
  return APOLLO_SOURCE_CATALOG.find((item) => item.id === id) || null;
}

export function filterApolloSourcesForRole(role = 'customer_service') {
  return APOLLO_SOURCE_CATALOG.filter((item) => item.roles.includes(role)).map(({ keywords, roles, ...item }) => ({ ...item }));
}

export function planApolloCatalogSources(question) {
  const value = String(question || '').trim().toLowerCase();
  if (!value) return [];
  return APOLLO_SOURCE_CATALOG
    .filter((item) => item.keywords.some((keyword) => value.includes(keyword)))
    .map((item) => item.id);
}

export function isApprovedApolloSource(id) {
  return APOLLO_SOURCE_IDS.includes(id);
}
