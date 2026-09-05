import categories from '../data/categories.json';
import { inferMotarroPathFromRow, isMotarroBrowsePath, isMotarroProduct, motarroPathMatchesFilter } from '../../lib/mottaro-category.mjs';
import { parseExtraLabels } from '../../lib/taxonomy-match.mjs';

// IMPORTANT: this MUST stay identical to labelToSlug in scripts/lib/master.mjs.
// The category generator fails on slug collisions, which guarantees this is a
// safe 1:1 mapping between a label and its slug at every level of the tree.
export function labelToSlug(label) {
  if (label === null || label === undefined) return '';
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Flat slug -> label map (first occurrence wins) for display helpers.
const SLUG_TO_LABEL = {};
(function index(nodes) {
  for (const n of nodes) {
    if (!(n.id in SLUG_TO_LABEL)) SLUG_TO_LABEL[n.id] = n.label;
    if (n.children?.length) index(n.children);
  }
})(categories);

export function slugToLabel(slug) {
  if (!slug) return '';
  return SLUG_TO_LABEL[slug] || String(slug).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build slug → label map from a live taxonomy tree (merged with bundled defaults). */
export function buildSlugToLabelMap(tree) {
  const map = { ...SLUG_TO_LABEL };
  function index(nodes) {
    for (const n of nodes || []) {
      map[n.id] = n.label;
      if (n.children?.length) index(n.children);
    }
  }
  index(tree);
  return map;
}

export function slugToLabelFromTree(slug, tree) {
  if (!slug) return '';
  if (Array.isArray(tree) && tree.length) {
    const map = buildSlugToLabelMap(tree);
    if (map[slug]) return map[slug];
  }
  return slugToLabel(slug);
}

/** Legacy nav ids whose slug no longer matches labelToSlug(label) after a rename. */
export const LEGACY_NAV_ALIASES = {
  // Pre-restructure aliases — keep old slugs resolving to new top-level ids
  'arts-crafts-stationery': 'arts-and-crafts',
  'art-supplies-and-stationery': 'arts-and-crafts',
  'beads-jewellery-accessories': 'beads',
  'events-parties': 'party-events-seasonals',
  'food-drinks': 'confectionery',
  'homeware-kitchen': 'homeware',
  'packaging': 'packaging-storage',
  'toys-games-kids': 'kids-toys-games',
};

/**
 * Map a navigation path (taxonomy node ids) to product categoryPath slugs.
 * Sort orders and product counts must use this key so the trade portal matches.
 */
export function resolveNavPathForProducts(navPath, categories) {
  if (!Array.isArray(navPath) || !navPath.length) return [];
  if (!Array.isArray(categories) || !categories.length) {
    return navPath.map((seg, i) => (i === 0 && LEGACY_NAV_ALIASES[seg]) || seg);
  }

  const out = [];
  let nodes = categories;
  for (let i = 0; i < navPath.length; i += 1) {
    const seg = navPath[i];
    const node = (nodes || []).find((n) => n.id === seg);
    if (!node) {
      // Node no longer in tree (deleted) — use alias as fallback so old product slugs still match.
      out.push(i === 0 && LEGACY_NAV_ALIASES[seg] ? LEGACY_NAV_ALIASES[seg] : seg);
      break;
    }
    // Node found: always derive the slug from the live label so renames are reflected immediately.
    out.push(labelToSlug(node.label));
    nodes = node.children || [];
  }
  return out;
}

/** Canonical key for sort-order storage (matches trade portal lookup). */
export function sortOrderCategoryKey(navPath, categories) {
  const resolved = resolveNavPathForProducts(navPath, categories);
  if (resolved.length) return resolved.join('/');
  return Array.isArray(navPath) && navPath.length ? navPath.join('/') : '';
}

/** All keys that may hold a saved order for this nav path (canonical + legacy). */
export function sortOrderLookupKeys(navPath, categories) {
  if (!Array.isArray(navPath) || !navPath.length) return [];
  const keys = [];
  const seen = new Set();
  const add = (key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  add(sortOrderCategoryKey(navPath, categories));
  add(navPath.join('/'));

  const resolved = resolveNavPathForProducts(navPath, categories);
  if (resolved.length) add(resolved.join('/'));

  const alias = LEGACY_NAV_ALIASES[navPath[0]];
  if (alias) {
    add([alias, ...navPath.slice(1)].join('/'));
    add([navPath[0], ...navPath.slice(1)].join('/'));
  }

  // Fall back to parent-level sort orders so a subcategory page inherits the
  // parent's saved order when no subcategory-specific order has been saved yet.
  for (let i = resolved.length - 1; i >= 1; i -= 1) {
    add(resolved.slice(0, i).join('/'));
  }

  return keys;
}

/** Find skuOrder[] for a category path in a sort-order store. */
export function lookupSortOrder(sortOrders, navPath, categories) {
  if (!sortOrders || !navPath?.length) return null;
  for (const key of sortOrderLookupKeys(navPath, categories)) {
    const skuOrder = sortOrders[key]?.skuOrder;
    if (Array.isArray(skuOrder) && skuOrder.length) return skuOrder;
  }
  return null;
}

export function applySkuOrder(products, skuOrder) {
  if (!skuOrder?.length) return products;
  const orderMap = new Map(skuOrder.map((id, i) => [id, i]));
  return [...products].sort((a, b) => (orderMap.get(a.id) ?? 999999) - (orderMap.get(b.id) ?? 999999));
}

/** Build a slug categoryPath from human labels (category + ordered subcategory levels). */
export function buildCategoryPath(category, subLabels = []) {
  const catSlug = labelToSlug(category);
  if (!catSlug) return [];
  const path = [catSlug];
  for (const sub of subLabels) {
    if (sub) path.push(labelToSlug(sub));
  }
  return path;
}

function normalizeLabel(label) {
  return String(label || '').trim().toLowerCase();
}

const SUB_COLS = ['subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four'];

function resolvePathFromLabels(nodes, labels, path) {
  if (!labels.length) return path;
  const [head, ...tail] = labels;
  const target = normalizeLabel(head);
  const matches = (nodes || []).filter((n) => normalizeLabel(n.label) === target);
  if (!matches.length) return [...path, labelToSlug(head)];
  for (const node of matches) {
    const result = resolvePathFromLabels(node.children || [], tail, [...path, node.id]);
    if (!tail.length) return result;
    if (result.length > path.length + 1) return result;
  }
  return [...path, labelToSlug(head)];
}

/**
 * Resolve a product row's labels to the *current* taxonomy node ids.
 * Taxonomy ids stay stable across rename, but product rows store the live
 * labels, so we must walk the tree by label match to get the right ids.
 */
export function resolveCategoryIdsFromTree(row, tree) {
  const fallback = () => {
    const ids = [];
    if (row.category) ids.push(labelToSlug(row.category));
    for (const col of SUB_COLS) {
      if (row[col]) ids.push(labelToSlug(row[col])); else break;
    }
    if (ids.length === 1 + SUB_COLS.length) {
      for (const label of parseExtraLabels(row.subcategory_extra)) {
        if (!label) break;
        ids.push(labelToSlug(label));
      }
    }
    return { categoryId: ids[0] || '', categoryPath: ids };
  };

  if (!Array.isArray(tree) || !tree.length) return fallback();

  const labels = [row.category, ...SUB_COLS.map((f) => row[f]), ...parseExtraLabels(row.subcategory_extra)]
    .filter((v) => v != null && String(v).trim());
  if (!labels.length) return { categoryId: '', categoryPath: [] };

  const main = tree.find((c) => normalizeLabel(c.label) === normalizeLabel(labels[0]));
  if (!main) return fallback();

  const path = resolvePathFromLabels(main.children || [], labels.slice(1), [main.id]);
  return { categoryId: path[0] || '', categoryPath: path };
}

function findMainNode(tree, navMainId) {
  const direct = (tree || []).find((c) => c.id === navMainId);
  if (direct) return direct;
  const mapped = LEGACY_NAV_ALIASES[navMainId];
  if (mapped) return (tree || []).find((c) => c.id === mapped) || null;
  return null;
}

/** True when an adapted product matches a taxonomy nav path (node ids). */
export function productMatchesNavPath(product, tree, navPath) {
  if (!Array.isArray(navPath) || !navPath.length) return true;
  if (navPath[0] === '__uncategorized__') {
    return !String(product.categoryLabel || '').trim() && !String(product.category || '').trim();
  }

  if (isMotarroBrowsePath(navPath)) {
    if (!isMotarroProduct(product)) return false;
    const row = {
      title: product.title || product.name || '',
      category: product.categoryLabel || '',
      subcategory_one: product.subcategoryLabels?.[0] ?? null,
      subcategory_two: product.subcategoryLabels?.[1] ?? null,
      subcategory_three: product.subcategoryLabels?.[2] ?? null,
      subcategory_four: product.subcategoryLabels?.[3] ?? null,
    };
    const mottaroPath = product.alternateCategoryPath?.length
      ? product.alternateCategoryPath
      : inferMotarroPathFromRow(row, tree);
    return motarroPathMatchesFilter(mottaroPath, navPath);
  }

  const main = findMainNode(tree, navPath[0]);
  if (!main) return false;
  if (normalizeLabel(product.categoryLabel || '') !== normalizeLabel(main.label)) return false;

  // subcategoryLabels already holds the full depth (fixed columns + any
  // subcategory_extra overflow) in order — no fixed-length cap here.
  const rowSubs = (product.subcategoryLabels || []).filter((v) => v != null && String(v).trim());
  let children = main.children || [];

  for (let i = 1; i < navPath.length; i += 1) {
    const node = (children || []).find((n) => n.id === navPath[i]);
    if (!node) return false;
    if (normalizeLabel(rowSubs[i - 1]) !== normalizeLabel(node.label)) return false;
    children = node.children || [];
  }
  return true;
}

export { categories };
