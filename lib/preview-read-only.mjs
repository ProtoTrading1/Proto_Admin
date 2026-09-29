// Opt-in protection for a review deployment sharing production read credentials.
// This is not authentication: allowed requests continue into the original route
// and its original authorization. Unknown routes fail closed, including GETs
// (some operational GET endpoints run syncs or seed configuration).
const READ_GET_PATHS = new Set([
  '/api/auth-check',
  '/api/taxonomy',
  '/api/catalog',
  '/api/products',
  '/api/specials',
  '/api/featured-products',
  '/api/banner',
  '/api/nutstore-browse',
  '/api/nutstore-thumbnail',
  '/api/nutstore-process',
  '/api/product-loader-lookup',
  '/api/product-loader-diag',
  '/api/product-loader-dormant',
  '/api/product-loader-publish-history',
  '/api/bridge-status',
  '/api/live-shoppers',
]);
const READ_POST_PATHS = new Set([
  '/api/auth-check',
  '/api/product-loader-batch-lookup',
  '/api/nutstore-batch-lookup',
  '/api/product-loader-variant-preview',
]);
const READ_STOCK_ACTIONS = new Set(['listLive', 'listArchived']);

export function previewReadOnlyBlock({ method = 'GET', url = '', body = null } = {}, enabled) {
  if (enabled !== '1') return null;
  let pathname;
  try { pathname = new URL(url, 'https://preview.invalid').pathname; } catch { pathname = ''; }
  // Middleware is mounted only on /api/:path*. If an encoded or unusual path
  // spelling reaches it, fail closed instead of treating it as out of scope.
  const verb = String(method).toUpperCase();
  if (verb === 'GET' && READ_GET_PATHS.has(pathname)) return null;
  if (verb === 'POST' && READ_POST_PATHS.has(pathname)) return null;
  if (verb === 'POST' && pathname === '/api/stock-actions' && READ_STOCK_ACTIONS.has(body?.action)) return null;
  return {
    status: 403,
    code: 'preview_read_only',
    error: 'This is a read-only preview. No products, images, stock, settings or messages have been changed. Use production for approved changes.',
  };
}
