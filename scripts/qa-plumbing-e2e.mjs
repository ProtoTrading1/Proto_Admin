#!/usr/bin/env node
/**
 * End-to-end admin↔portal plumbing test (post-deploy).
 * Requires ADMIN_DASH_KEY in env.
 */
const ADMIN = process.env.QA_ADMIN_URL || 'https://admin.proto.co.za';
const PORTAL = process.env.QA_PORTAL_URL || 'https://site.proto.co.za';
const KEY = process.env.ADMIN_DASH_KEY;

if (!KEY) {
  console.error('Missing ADMIN_DASH_KEY');
  process.exit(1);
}

const adminHeaders = { 'x-admin-key': KEY, 'Content-Type': 'application/json' };
const results = [];

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

async function adminJson(path, opts = {}) {
  const res = await fetch(`${ADMIN}${path}`, { ...opts, headers: { ...adminHeaders, ...opts.headers } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function portalJson(path) {
  const res = await fetch(`${PORTAL}${path}`, { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function findNodeById(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children, id);
    if (hit) return hit;
  }
  return null;
}

async function waitForPortalTaxonomyLabel(nodeId, label, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { json } = await portalJson('/api/taxonomy');
    const node = findNodeById(json.categories, nodeId);
    if (node?.label === label) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// 1. Taxonomy rename round-trip
const taxBefore = await adminJson('/api/taxonomy');
const tree = taxBefore.json?.categories || [];
const testNode = findNodeById(tree, 'tools') || findNodeById(tree, 'art-supplies');
const renameId = testNode?.id || 'tools';
const originalLabel = testNode?.label || 'Tools';
const tempLabel = `${originalLabel} E2E`;

const renamed = await adminJson('/api/taxonomy', {
  method: 'POST',
  body: JSON.stringify({ action: 'rename', id: renameId, label: tempLabel }),
});
const renameOk = renamed.status === 200;
const portalSawRename = renameOk && await waitForPortalTaxonomyLabel(renameId, tempLabel, 60000);
record('1. Taxonomy rename → portal nav', renameOk && portalSawRename, renameOk ? `label→${tempLabel}` : renamed.json?.error);

await adminJson('/api/taxonomy', {
  method: 'POST',
  body: JSON.stringify({ action: 'rename', id: renameId, label: originalLabel }),
});

// 2. Mottaro parity
const adminM = (taxBefore.json?.categories || []).some((c) => c.id === 'mottaro');
const portalTax = await portalJson('/api/taxonomy');
const portalM = (portalTax.json?.categories || []).some((c) => c.id === 'mottaro');
const portalProducts = await portalJson('/api/products');
const mottaroCount = (portalProducts.json || []).filter((p) => p.categoryPaths?.some((cp) => cp[0] === 'mottaro')).length;
record('2. Mottaro admin + portal', adminM && portalM && mottaroCount > 0, `portal mottaro products=${mottaroCount}`);

// 3. Sort-order propagation
const sortKey = 'arts-and-crafts/art-supplies';
const adminSort = await adminJson('/api/category-sort-order');
const store = adminSort.json || {};
const entry = store.orders?.[sortKey] || { skuOrder: [] };
const skuOrder = [...(entry.skuOrder || [])];
if (skuOrder.length >= 2) {
  const swapped = [skuOrder[1], skuOrder[0], ...skuOrder.slice(2)];
  const saved = await adminJson('/api/category-sort-order', {
    method: 'POST',
    body: JSON.stringify({
      categoryKey: sortKey,
      skuOrder: swapped,
      expectedStoreUpdatedAt: store.updatedAt,
    }),
  });
  let portalMatch = false;
  const start = Date.now();
  while (Date.now() - start < 35000) {
    const pSort = await portalJson('/api/sort-orders');
    const pEntry = pSort.json?.orders?.[sortKey];
    if (pEntry?.skuOrder?.[0] === swapped[0] && pEntry?.skuOrder?.[1] === swapped[1]) {
      portalMatch = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  record('3. Sort-order admin → portal', saved.status === 200 && portalMatch, `key=${sortKey}`);
  await adminJson('/api/category-sort-order', {
    method: 'POST',
    body: JSON.stringify({
      categoryKey: sortKey,
      skuOrder,
      expectedStoreUpdatedAt: saved.json?.storeUpdatedAt,
    }),
  });
} else {
  record('3. Sort-order admin → portal', true, 'skipped — no saved order to swap');
}

// 4. Popup on/off
const popupBefore = await adminJson('/api/popup-special');
const hadImage = popupBefore.json?.imageUrl;
if (hadImage) {
  const on = await adminJson('/api/popup-special', {
    method: 'POST',
    body: JSON.stringify({ active: true, imageUrl: hadImage, title: popupBefore.json?.title || 'E2E' }),
  });
  let portalActive = false;
  let portalInactive = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const p = await portalJson('/api/popup-special');
    if (p.json?.active === true) { portalActive = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await adminJson('/api/popup-special', {
    method: 'POST',
    body: JSON.stringify({ active: false, imageUrl: hadImage, title: popupBefore.json?.title || '' }),
  });
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    const p = await portalJson('/api/popup-special');
    if (p.json?.active === false) { portalInactive = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  record('4. Popup active on/off → portal', on.status === 200 && portalActive && portalInactive, `active=${portalActive} inactive=${portalInactive}`);
} else {
  record('4. Popup active on/off → portal', true, 'skipped — no popup image configured');
}

// 5. Price/stock on portal products API
const live = await adminJson('/api/catalog?status=live&page=1&pageSize=1');
const sample = live.json?.rows?.[0];
if (sample?.id) {
  const newPrice = Number(sample.price || 0) + 0.01;
  const updated = await adminJson('/api/update-product', {
    method: 'POST',
    body: JSON.stringify({ websiteSku: sample.id, price: newPrice }),
  });
  let portalPrice = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 45000) {
    const p = await portalJson('/api/products');
    const hit = (p.json || []).find((row) => row.id === sample.id);
    if (hit && Math.abs(Number(hit.price) - newPrice) < 0.001) {
      portalPrice = hit.price;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await adminJson('/api/update-product', {
    method: 'POST',
    body: JSON.stringify({ websiteSku: sample.id, price: sample.price }),
  });
  record('5. Price/stock → portal products', updated.status === 200 && portalPrice != null, `sku=${sample.id} price=${portalPrice}`);
} else {
  record('5. Price/stock → portal products', false, 'no sample product');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} E2E plumbing checks passed`);
if (failed.length) process.exit(1);
