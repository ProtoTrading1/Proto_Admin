#!/usr/bin/env node
/**
 * Production API smoke tests (requires ADMIN_DASH_KEY + VITE_SUPABASE_URL in env).
 * Run: set -a && source .env.production.local && set +a && node scripts/qa-api-check.mjs
 */
const BASE = process.env.QA_BASE_URL || 'https://admin.proto.co.za';
const KEY = process.env.ADMIN_DASH_KEY;

if (!KEY) {
  console.error('Missing ADMIN_DASH_KEY');
  process.exit(1);
}

const headers = { 'x-admin-key': KEY };

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function patch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const results = [];

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

// Taxonomy / Mottaro
const tax = await get('/api/taxonomy');
const cats = tax.json?.categories || tax.json || [];
record('Mottaro in /api/taxonomy', tax.status === 200 && cats.some((c) => c.id === 'mottaro'), `status ${tax.status}`);
record('Taxonomy exposes updatedAt', tax.status === 200 && !!tax.json?.updatedAt, tax.json?.updatedAt || 'missing');

const staleTax = await post('/api/taxonomy', {
  action: 'replace',
  categories: cats.filter((c) => c.id !== 'mottaro'),
  expectedUpdatedAt: '1970-01-01T00:00:00.000Z',
});
record('Taxonomy stale expectedUpdatedAt → 409', staleTax.status === 409, staleTax.json?.error || `status ${staleTax.status}`);

// Bulk products validation
const emptyBulk = await post('/api/bulk-products', { action: 'archive', skus: [] });
record('Bulk products rejects empty skus', emptyBulk.status === 400, emptyBulk.json?.error || `status ${emptyBulk.status}`);

// Query validation
const badTab = await get('/api/admin-orders?tab=not-a-tab');
record('Orders invalid tab → 400', badTab.status === 400, `status ${badTab.status}`);

const badPage = await get('/api/admin-orders?page=abc');
record('Orders invalid page → 400', badPage.status === 400, `status ${badPage.status}`);

const badCust = await get('/api/admin-customers?tab=nope');
record('Customers invalid tab → 400', badCust.status === 400, `status ${badCust.status}`);

// Orders pagination
const ordersP1 = await get('/api/admin-orders?page=1&pageSize=50&tab=all');
record('Orders paginated list', ordersP1.status === 200 && Array.isArray(ordersP1.json?.rows), `total=${ordersP1.json?.total}`);

const ordersP2 = await get('/api/admin-orders?page=2&pageSize=50&tab=all');
record('Orders page 2 reachable', ordersP2.status === 200, `rows=${ordersP2.json?.rows?.length}`);

// Sent tab DB pagination (post QA-1)
const sentTab = await get('/api/admin-orders?page=1&pageSize=25&tab=sent');
record('Sent tab paginated', sentTab.status === 200, `total=${sentTab.json?.total}, truncated=${sentTab.json?.truncated ?? false}`);

// Direct status PATCH rejected
const orders = ordersP1.json?.rows || [];
if (orders[0]?.id) {
  const direct = await patch('/api/admin-orders', { id: orders[0].id, status: 'payment received' });
  record('Direct status PATCH rejected', direct.status === 400, direct.json?.error || `status ${direct.status}`);
} else {
  record('Direct status PATCH rejected', true, 'skipped — no orders');
}

// Catalog DB pagination (plain browse)
const catBrowse = await get('/api/catalog?status=live&page=1&pageSize=50&categoryPath=%5B%22arts-and-crafts%22%5D');
const rowCount = catBrowse.json?.rows?.length ?? 0;
const total = catBrowse.json?.total ?? 0;
record('Catalog plain browse paginated', catBrowse.status === 200 && rowCount <= 50, `rows=${rowCount} total=${total}`);

// Search consistency live vs archived
const liveSearch = await get('/api/catalog?status=live&page=1&pageSize=20&search=canvas');
const archSearch = await get('/api/catalog?status=archived&page=1&pageSize=20&search=canvas');
record('Live search canvas', liveSearch.status === 200, `rows=${liveSearch.json?.rows?.length}`);
record('Archived search canvas', archSearch.status === 200, `rows=${archSearch.json?.rows?.length}`);

// Business type filter
const unspecified = await get('/api/admin-customers?tab=regular&business_type=__unspecified__&pageSize=5');
record('Customer Unspecified filter', unspecified.status === 200, `rows=${unspecified.json?.rows?.length}`);

// Popup special API
const popup = await get('/api/popup-special');
record('Popup special GET', popup.status === 200, `active=${popup.json?.active}`);

const featured = await get('/api/featured-products');
record('Featured products GET', featured.status === 200 && Array.isArray(featured.json?.items), `count=${featured.json?.items?.length ?? 0}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
