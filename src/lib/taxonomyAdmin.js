import bundledCategories from '../data/categories.json';
import { labelToSlug } from './taxonomy';

let _taxonomyUpdatedAt = null;

export function getTaxonomyUpdatedAt() {
  return _taxonomyUpdatedAt;
}

async function postTaxonomy(body) {
  const res = await fetch('/api/taxonomy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      expectedUpdatedAt: getTaxonomyUpdatedAt(),
    }),
  });
  const json = await res.json();
  if (res.status === 409) {
    const err = new Error(json.error || 'Categories were changed by someone else — reload before saving.');
    err.status = 409;
    err.currentUpdatedAt = json.currentUpdatedAt;
    throw err;
  }
  if (!res.ok) throw new Error(json.error || 'Taxonomy update failed');
  if (json.updatedAt) _taxonomyUpdatedAt = json.updatedAt;
  return json;
}

export async function fetchTaxonomy({ withCounts = false } = {}) {
  try {
    const qs = withCounts ? '?counts=1' : '';
    const res = await fetch(`/api/taxonomy${qs}`);
    if (!res.ok) throw new Error(`Taxonomy ${res.status}`);
    const json = await res.json();
    // Only the plain (no-store) GET may set the optimistic-lock token. The
    // ?counts=1 endpoint is edge-cached and can return a stale updatedAt,
    // which would poison the token and cause spurious 409s on the next edit.
    if (!withCounts && json.updatedAt) _taxonomyUpdatedAt = json.updatedAt;
    const categories = json.categories || bundledCategories;
    return withCounts
      ? { categories, counts: json.counts || {}, updatedAt: json.updatedAt || null }
      : categories;
  } catch {
    return withCounts ? { categories: bundledCategories, counts: {}, updatedAt: null } : bundledCategories;
  }
}

export async function fetchCategoryProductCounts({ onlyInStock = false, fresh = false } = {}) {
  const stockParam = onlyInStock ? '&onlyInStock=1' : '';
  // Let the server's 15s SWR edge cache serve this — it's a full website_stock
  // scan, and busting it (a unique ?_=Date.now() + no-store) forced that scan on
  // every dashboard load and every concurrent admin. Counts don't set the edit
  // lock token, so a slightly-cached count is fine.
  //
  // EXCEPT straight after a write. s-maxage=15 + stale-while-revalidate=45
  // means a rename could read back numbers computed up to a minute earlier —
  // the category shows its old count, or none, and a rename that worked looks
  // broken. Only that path pays for a fresh scan.
  const bust = fresh ? `&_=${Date.now()}` : '';
  const res = await fetch(`/api/taxonomy?counts=1${stockParam}${bust}`, fresh ? { cache: 'no-store' } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load category counts');
  // Do NOT set _taxonomyUpdatedAt here — see fetchTaxonomy note; the counts
  // response can be stale and corrupt the edit lock token.
  return json.counts || {};
}

export async function renameTaxonomyNode(id, label) {
  return postTaxonomy({ action: 'rename', id, label });
}

export async function createCategory(label) {
  return postTaxonomy({ action: 'addCategory', label });
}

export async function createSubcategory(parentId, label) {
  return postTaxonomy({ action: 'addSubcategory', parentId, label });
}

// Deletes a category or subcategory (and its subtree). Live products under it
// are ARCHIVED server-side (kept with their labels so they can be restored
// from the Archive later) — the response reports productsArchived.
export async function deleteTaxonomyNode(id) {
  return postTaxonomy({ action: 'deleteNode', id });
}

// Deleted Motarro subcategories are virtual, so "delete" hides the node.
// These let the admin see and undo those hides (the archived products are
// restored separately from the Archive tab).
export async function listHiddenMottaro() {
  const json = await postTaxonomy({ action: 'listHiddenMottaro' });
  return json.ids || [];
}

export async function restoreMottaroNode(id) {
  return postTaxonomy({ action: 'restoreMottaroNode', id });
}

export async function countSubcategoryProducts(id) {
  const res = await fetch('/api/taxonomy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'countSubcategoryProducts', id }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Count failed');
  return json.productCount || 0;
}

export function findInTree(tree, id) {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.children?.length) {
      const hit = findInTree(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function categoryLabelFromTree(tree, id) {
  return findInTree(tree, id)?.label || id;
}

export function subcategoryOptionsFromTree(tree, categoryId) {
  return findInTree(tree, categoryId)?.children || [];
}

export function childrenOfTree(tree, id) {
  if (!id) return [];
  const stack = [...(tree || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.id === id) return node.children || [];
    if (node.children?.length) stack.push(...node.children);
  }
  return [];
}

export function flattenSubcategories(nodes, depth = 1, prefix = '') {
  const out = [];
  for (const node of nodes || []) {
    const path = prefix ? `${prefix} › ${node.label}` : node.label;
    out.push({ id: node.id, label: node.label, depth, path });
    if (node.children?.length) {
      out.push(...flattenSubcategories(node.children, depth + 1, path));
    }
  }
  return out;
}

export async function replaceFullTaxonomy(categories) {
  return postTaxonomy({ action: 'replace', categories });
}

export { labelToSlug, bundledCategories };
