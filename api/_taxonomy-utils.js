import { readFileSync } from 'fs';
import { join } from 'path';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';
import { isPublishableOnWebsite } from '../lib/catalog-stock.mjs';
import { isMotarroProduct, inferMotarroPathFromRow, injectMotarroIntoTree } from './_mottaro-category.js';
import { collectCountableNodeIds } from './_placements.js';
import {
  escapeIlikePattern,
  matchesTaxonomyLabel,
  normalizeLabel,
  parseExtraLabels,
  rowMatchesLabelScope,
} from '../lib/taxonomy-match.mjs';

const TAXONOMY_FILE = 'taxonomy/categories.json';
const MOTTARO_HIDDEN_FILE = 'taxonomy/mottaro-hidden.json';
const BUNDLED_PATH = join(process.cwd(), 'src/data/categories.json');

export function labelToSlug(label) {
  if (label === null || label === undefined) return '';
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function loadBundledTaxonomy() {
  return JSON.parse(readFileSync(BUNDLED_PATH, 'utf8'));
}

let _taxonomyCache = null;
let _taxonomyCachedAt = 0;
// Short TTL: the taxonomy store is small and read cheaply, and a long cache
// meant a category edit could take up to a minute to appear on another warm
// serverless instance (admin AND main portal) — the "changes don't stick /
// don't reflect" symptom. Keep it tiny so the mirror stays effectively live.
const TAXONOMY_TTL_MS = 5_000;

export function invalidateTaxonomyCache() {
  _taxonomyCache = null;
  _taxonomyCachedAt = 0;
  _hiddenCache = null;
  _hiddenCachedAt = 0;
}

// Deleted Motarro subcategory ids (the Motarro tree is virtual, so "delete"
// means "hide this node"). Cached with the same short TTL as the taxonomy.
let _hiddenCache = null;
let _hiddenCachedAt = 0;

export async function readMottaroHiddenIds({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _hiddenCache && now - _hiddenCachedAt < TAXONOMY_TTL_MS) return _hiddenCache;
  let ids = [];
  try {
    const stored = await readSiteConfigJson(MOTTARO_HIDDEN_FILE, null);
    if (Array.isArray(stored?.ids)) ids = stored.ids.filter((x) => typeof x === 'string' && x);
    else if (Array.isArray(stored)) ids = stored.filter((x) => typeof x === 'string' && x);
  } catch { /* default to none hidden */ }
  _hiddenCache = ids;
  _hiddenCachedAt = now;
  return ids;
}

export async function writeMottaroHiddenIds(ids) {
  const clean = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
  const saved = await writeSiteConfigJson(MOTTARO_HIDDEN_FILE, { ids: clean });
  _hiddenCache = clean;
  _hiddenCachedAt = Date.now();
  return { ids: clean, updatedAt: saved.updatedAt || null };
}

function withMotarro(categories, hiddenIds = _hiddenCache || []) {
  return injectMotarroIntoTree(Array.isArray(categories) ? categories : [], hiddenIds);
}

/**
 * Single fresh read for the API layer: returns the Mottaro-injected tree AND
 * its updatedAt from the SAME store read, so a GET can never pair a new
 * updatedAt with a stale tree (which corrupted the optimistic-lock token and
 * made edits look reverted).
 */
export async function readTaxonomyForApi() {
  const [store, hidden] = await Promise.all([readTaxonomyStore(), readMottaroHiddenIds()]);
  return { categories: withMotarro(store.categories, hidden), updatedAt: store.updatedAt };
}

export async function loadTaxonomy({ bypassCache = false } = {}) {
  const now = Date.now();
  const hidden = await readMottaroHiddenIds({ bypassCache });
  if (!bypassCache && _taxonomyCache && now - _taxonomyCachedAt < TAXONOMY_TTL_MS) {
    return withMotarro(_taxonomyCache, hidden);
  }
  try {
    const stored = await readSiteConfigJson(TAXONOMY_FILE, null);
    if (Array.isArray(stored)) {
      _taxonomyCache = stored;
      _taxonomyCachedAt = now;
      return withMotarro(stored, hidden);
    }
    if (stored?.categories && Array.isArray(stored.categories)) {
      _taxonomyCache = stored.categories;
      _taxonomyCachedAt = now;
      return withMotarro(stored.categories, hidden);
    }
  } catch { /* fall through */ }
  const bundled = loadBundledTaxonomy();
  _taxonomyCache = bundled;
  _taxonomyCachedAt = now;
  return withMotarro(bundled, hidden);
}

/** Read stored taxonomy payload (categories + updatedAt) without Mottaro injection. */
export async function readTaxonomyStore() {
  try {
    const stored = await readSiteConfigJson(TAXONOMY_FILE, null);
    if (Array.isArray(stored)) {
      return { categories: stored, updatedAt: null };
    }
    if (stored?.categories && Array.isArray(stored.categories)) {
      return { categories: stored.categories, updatedAt: stored.updatedAt || null };
    }
  } catch { /* fall through */ }
  const bundled = loadBundledTaxonomy();
  return { categories: bundled, updatedAt: null };
}

export async function saveTaxonomy(categories, { expectedUpdatedAt } = {}) {
  const stripped = (Array.isArray(categories) ? categories : []).filter((c) => c.id !== 'mottaro');

  const expected = expectedUpdatedAt != null ? String(expectedUpdatedAt).trim() : '';
  if (expected) {
    const fresh = await readSiteConfigJson(TAXONOMY_FILE, null);
    const currentUpdatedAt = fresh?.updatedAt || null;
    if (currentUpdatedAt && currentUpdatedAt !== expected) {
      const err = new Error('Categories were changed by someone else — reload before saving.');
      err.status = 409;
      err.currentUpdatedAt = currentUpdatedAt;
      throw err;
    }
  }

  const saved = await writeSiteConfigJson(TAXONOMY_FILE, { categories: stripped });
  invalidateTaxonomyCache();
  _taxonomyCache = stripped;
  _taxonomyCachedAt = Date.now();
  const hidden = await readMottaroHiddenIds();
  return { categories: withMotarro(stripped, hidden), updatedAt: saved.updatedAt || null };
}

export function findNodeContext(tree, id, parent = null, depth = 0, ancestors = []) {
  for (const node of tree) {
    if (node.id === id) return { node, parent, depth, ancestors: [...ancestors] };
    if (node.children?.length) {
      const hit = findNodeContext(node.children, id, node, depth + 1, [...ancestors, node]);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * EVERY node carrying an id, not just the first.
 *
 * Ids are supposed to be unique but historically were only checked against
 * SIBLINGS when a subcategory was added, so a label reused in two branches
 * ("Opaque" under three bead sizes, "SIZE: 8mm" under several) produced two or
 * three nodes sharing one id. findNodeContext returns the first of them, so an
 * edit aimed at one silently lands on another — the node you clicked keeps its
 * name while a different branch is renamed and ITS products are relabelled.
 */
export function findAllNodeContexts(tree, id, parent = null, depth = 0, ancestors = []) {
  const hits = [];
  for (const node of tree) {
    if (node.id === id) hits.push({ node, parent, depth, ancestors: [...ancestors] });
    if (node.children?.length) {
      hits.push(...findAllNodeContexts(node.children, id, node, depth + 1, [...ancestors, node]));
    }
  }
  return hits;
}

/** Human-readable "Beads › Seed Beads › SIZE: 8/0 › Opaque" for a context. */
export function nodePathLabel(ctx) {
  return [...(ctx.ancestors || []).map((a) => a.label), ctx.node.label].join(' › ');
}

/**
 * Resolve exactly one node, or refuse. Editing the wrong branch silently is
 * far worse than refusing: the admin can rename the duplicate first and then
 * come back, but they cannot undo a rename applied to products they never saw.
 */
export function resolveSingleNode(tree, id) {
  const hits = findAllNodeContexts(tree, id);
  if (!hits.length) return null;
  if (hits.length > 1) {
    const err = new Error(
      `"${hits[0].node.label}" shares its internal id with ${hits.length - 1} other categor${hits.length === 2 ? 'y' : 'ies'} `
      + `(${hits.map(nodePathLabel).join(' | ')}). Rename one of them to something unique first — `
      + 'editing now would change the wrong one.',
    );
    err.status = 409;
    err.ambiguousId = id;
    err.matches = hits.map(nodePathLabel);
    throw err;
  }
  return hits[0];
}

/** All ids used anywhere in the tree, for global uniqueness checks. */
export function collectNodeIds(tree, out = new Set()) {
  for (const node of tree || []) {
    if (node?.id) out.add(node.id);
    if (node.children?.length) collectNodeIds(node.children, out);
  }
  return out;
}

export function findSubPathIds(mainNode, targetId) {
  function walk(nodes, path) {
    for (const node of nodes) {
      const next = [...path, node.id];
      if (node.id === targetId) return next;
      if (node.children?.length) {
        const hit = walk(node.children, next);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(mainNode.children || [], []);
}

export function resolvePathLabels(tree, categoryId, subcategoryIds = []) {
  const main = tree.find((c) => c.id === categoryId);
  if (!main) throw new Error('Main category not found');

  const labels = [main.label];
  let children = main.children || [];
  for (const subId of subcategoryIds.filter(Boolean)) {
    const child = children.find((c) => c.id === subId);
    if (!child) throw new Error(`Subcategory "${subId}" not found under ${main.label}`);
    labels.push(child.label);
    children = child.children || [];
  }
  return labels;
}

export function resolveLabelsForSubcategory(tree, categoryId, subcategoryId) {
  const main = tree.find((c) => c.id === categoryId);
  if (!main) throw new Error('Main category not found');
  if (!subcategoryId) throw new Error('Subcategory is required');
  const pathIds = findSubPathIds(main, subcategoryId);
  if (!pathIds?.length) throw new Error('Subcategory not found in this category');
  return resolvePathLabels(tree, categoryId, pathIds);
}

export function labelsToDbFields(labels) {
  const extra = labels.slice(5).filter((v) => v != null && String(v).trim());
  return {
    category: labels[0],
    subcategory_one: labels[1] || labels[0],
    subcategory_two: labels[2] || null,
    subcategory_three: labels[3] || null,
    subcategory_four: labels[4] || null,
    subcategory_extra: extra.length ? JSON.stringify(extra) : null,
  };
}

/**
 * Resolve the current taxonomy ids for a product row's labels.
 * Taxonomy node ids stay stable across rename, but the labels stored in the
 * DB rows change. Filtering / URL generation must use the *current* ids, not
 * a slug derived from the new label.
 *
 * Falls back to slug-of-label when a label has no match in the tree (e.g.
 * a freshly imported product whose category was removed from the taxonomy).
 */
export function resolveCategoryIds(row, tree) {
  if (!Array.isArray(tree) || !tree.length) {
    // No tree available — fall back to slug-of-label so the catalogue keeps loading
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
  }

  const labels = [
    row.category, row.subcategory_one, row.subcategory_two, row.subcategory_three, row.subcategory_four,
    ...parseExtraLabels(row.subcategory_extra),
  ];
  const ids = [];
  let level = tree;
  for (const rawLabel of labels) {
    if (!rawLabel) break;
    const target = normalizeLabel(rawLabel);
    const node = (level || []).find((n) => normalizeLabel(n.label) === target);
    if (!node) {
      // Couldn't resolve this depth — fall back to slug for remainder
      ids.push(labelToSlug(rawLabel));
      break;
    }
    ids.push(node.id);
    level = node.children || [];
  }
  return { categoryId: ids[0] || '', categoryPath: ids };
}

const SUB_COLS = ['subcategory_one', 'subcategory_two', 'subcategory_three', 'subcategory_four'];
const EXTRA_COL = 'subcategory_extra';

/**
 * Depth beyond the fixed subcategory_one..four columns (0 or negative means
 * the depth is still within the fixed columns) is stored as a single JSON
 * array in `subcategory_extra`, ordered from the first beyond-depth ancestor
 * to the node itself. `ctx.ancestors` has length === ctx.depth (root at
 * index 0), so ancestors[SUB_COLS.length] is the first node beyond the fixed
 * columns.
 */
function buildAncestorFilters(ancestors, depth) {
  const filters = { category: ancestors[0]?.label };
  for (let i = 1; i < depth; i++) {
    const label = ancestors[i]?.label;
    if (i - 1 < SUB_COLS.length) filters[SUB_COLS[i - 1]] = label;
    else (filters[EXTRA_COL] ||= []).push(label);
  }
  return filters;
}

export function buildRenameFilter(ctx, oldLabel) {
  const { depth, ancestors } = ctx;
  if (depth === 0) {
    return { column: 'category', filters: { category: oldLabel } };
  }
  const filters = buildAncestorFilters(ancestors, depth);
  let column;
  if (depth - 1 < SUB_COLS.length) {
    column = SUB_COLS[depth - 1];
    filters[column] = oldLabel;
  } else {
    column = EXTRA_COL;
    (filters[EXTRA_COL] ||= []).push(oldLabel);
  }
  return { column, filters };
}

export function addCategoryNode(tree, label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('Category name is required');
  const id = labelToSlug(trimmed);
  if (!id) throw new Error('Invalid category name');

  const existing = tree.find((c) => c.id === id);
  if (existing) {
    if (existing.label !== trimmed) {
      throw new Error(`Slug collision: "${existing.label}" and "${trimmed}" both map to "${id}"`);
    }
    return { tree, node: existing, created: false };
  }

  const node = { id, label: trimmed, children: [] };
  return { tree: [...tree, node], node, created: true };
}

/**
 * A slug that no node anywhere in the tree is already using.
 *
 * Ids must be unique across the WHOLE tree, not just among siblings. Every
 * id-keyed operation — rename, delete, the count badges, browsing by path —
 * resolves an id to one node, so a second node sharing it makes those
 * operations land on whichever comes first. Checking siblings only is how the
 * live tree ended up with "Opaque" three times over, once under each bead
 * size. The same label in two branches is perfectly legitimate; only the id
 * has to differ, so disambiguate rather than reject.
 */
export function uniqueNodeId(tree, baseId) {
  const used = collectNodeIds(tree);
  if (!used.has(baseId)) return baseId;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${baseId}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique id for "${baseId}"`);
}

export function addSubcategoryNode(tree, parentId, label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('Subcategory name is required');
  const slug = labelToSlug(trimmed);
  if (!slug) throw new Error('Invalid subcategory name');

  const ctx = findNodeContext(tree, parentId);
  if (!ctx) throw new Error('Parent category not found');

  const siblings = ctx.node.children || [];
  const existing = siblings.find((c) => normalizeLabel(c.label) === normalizeLabel(trimmed));
  if (existing) return { tree, node: existing, created: false };

  const node = { id: uniqueNodeId(tree, slug), label: trimmed, children: [] };
  ctx.node.children = [...siblings, node];
  return { tree: [...tree], node, created: true };
}

export function renameNodeLabel(tree, id, newLabel) {
  const trimmed = String(newLabel || '').trim();
  if (!trimmed) throw new Error('Name is required');
  const ctx = findNodeContext(tree, id);
  if (!ctx) throw new Error('Category not found');
  const oldLabel = ctx.node.label;
  if (oldLabel === trimmed) return { tree, oldLabel, ctx };
  ctx.node.label = trimmed;
  return { tree: [...tree], oldLabel, ctx };
}

/**
 * Delete a node at any depth (category or subcategory) together with its whole
 * subtree. Callers must also clear the affected products' stored labels via
 * clearProductsForDeletedNode, or phantom category paths survive the delete.
 */
export function deleteNodeCascade(tree, id) {
  const ctx = findNodeContext(tree, id);
  if (!ctx) throw new Error('Category not found');
  if (ctx.depth === 0) {
    return { tree: tree.filter((n) => n.id !== id), ctx };
  }
  if (!ctx.parent) throw new Error('Parent category not found');
  ctx.parent.children = (ctx.parent.children || []).filter((child) => child.id !== id);
  return { tree: [...tree], ctx };
}

export function buildNodeProductFilter(ctx) {
  const { depth, ancestors, node } = ctx;
  if (depth === 0) {
    return { filters: { category: node.label } };
  }
  const filters = buildAncestorFilters(ancestors, depth);
  if (depth - 1 < SUB_COLS.length) {
    filters[SUB_COLS[depth - 1]] = node.label;
  } else {
    (filters[EXTRA_COL] ||= []).push(node.label);
  }
  return { filters };
}

const SCOPE_FETCH_COLS = 'sku,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,subcategory_extra';

/**
 * Sort key for every paged scan in this module.
 *
 * LIMIT/OFFSET without an ORDER BY has NO stable row order: Postgres re-runs
 * the scan for each page, and any UPDATE in between rewrites that row at the
 * end of the heap and shifts every later row back one position — so the next
 * page starts past a row that was never served. website_stock is written to
 * continuously by the Positill stock sync, so this is not theoretical: a scan
 * that needs more than one page (a main category, or any full-table pass)
 * silently skips products. `sku` is UNIQUE and never changes, so ordering by
 * it makes the pages deterministic.
 */
const PAGE_SORT_COLUMN = 'sku';

/**
 * Fetch rows belonging to a node scope with whitespace/case-tolerant matching.
 * Pass 1 narrows server-side with a contains-ilike on the deepest column
 * (catches padded values like " Fasteners"); pass 2 verifies the full
 * ancestor scope in JS with the shared normalized matcher.
 */
export async function fetchRowsMatchingNodeScope(supabase, table, { column, filters }) {
  const rawLabel = filters[column];
  // subcategory_extra filters are an ordered label array; the deepest (last)
  // element is the node's own label and the most selective ilike substring —
  // exactness is still enforced afterwards by rowMatchesLabelScope.
  const label = Array.isArray(rawLabel)
    ? String(rawLabel[rawLabel.length - 1] ?? '').trim()
    : String(rawLabel ?? '').trim();
  if (!label) return [];
  const pattern = `%${escapeIlikePattern(label)}%`;
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(SCOPE_FETCH_COLS)
      .ilike(column, pattern)
      .order(PAGE_SORT_COLUMN, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data || [];
    for (const row of batch) {
      if (rowMatchesLabelScope(row, filters)) rows.push(row);
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/** Deepest column of a node scope — the column that names the node itself. */
export function nodeScopeColumn(ctx) {
  if (ctx.depth === 0) return 'category';
  return ctx.depth - 1 < SUB_COLS.length ? SUB_COLS[ctx.depth - 1] : EXTRA_COL;
}

export async function countProductsForNode(supabase, ctx) {
  const { filters } = buildNodeProductFilter(ctx);
  const rows = await fetchRowsMatchingNodeScope(supabase, 'website_stock', {
    column: nodeScopeColumn(ctx),
    filters,
  });
  return rows.length;
}

const PRODUCT_UPDATE_CHUNK = 200;

async function chunkedSkuUpdate(supabase, table, skus, patch) {
  for (let i = 0; i < skus.length; i += PRODUCT_UPDATE_CHUNK) {
    const { error } = await supabase
      .from(table)
      .update(patch)
      .in('sku', skus.slice(i, i + PRODUCT_UPDATE_CHUNK));
    if (error) throw error;
  }
}

/**
 * Rename a node's label on every product row in one table, tolerant of
 * whitespace/case drift in stored labels. Shallow rows duplicate the main
 * category label into subcategory_one, so a depth-0 rename must update both
 * columns or the row orphans at depth 1.
 */
export async function renameNodeLabelInProducts(supabase, table, ctx, oldLabel, newLabel) {
  const { column, filters } = buildRenameFilter(ctx, oldLabel);
  const rows = await fetchRowsMatchingNodeScope(supabase, table, { column, filters });
  if (!rows.length) return { renamed: 0 };
  const stamp = new Date().toISOString();

  if (column === EXTRA_COL) {
    // Rows under an extras-depth node can each carry a different NUMBER of
    // deeper descendant elements after the renamed position, so (unlike the
    // fixed-column case) one uniform patch can't be applied to every matched
    // row — each row's extras array must be read and spliced individually.
    const extraIndex = ctx.depth - 1 - SUB_COLS.length;
    let renamed = 0;
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const row = rows[cursor];
        cursor += 1;
        const currentExtra = parseExtraLabels(row.subcategory_extra);
        if (!matchesTaxonomyLabel(currentExtra[extraIndex], oldLabel)) continue;
        const nextExtra = [...currentExtra];
        nextExtra[extraIndex] = newLabel;
        const { error } = await supabase
          .from(table)
          .update({ subcategory_extra: JSON.stringify(nextExtra), updated_at: stamp })
          .eq('sku', row.sku);
        if (!error) renamed += 1;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()));
    return { renamed };
  }

  const needsSubOne = (row) => ctx.depth === 0 && matchesTaxonomyLabel(row.subcategory_one, oldLabel);
  const dualSkus = rows.filter((r) => needsSubOne(r)).map((r) => r.sku).filter(Boolean);
  const singleSkus = rows.filter((r) => !needsSubOne(r)).map((r) => r.sku).filter(Boolean);
  await chunkedSkuUpdate(supabase, table, singleSkus, { [column]: newLabel, updated_at: stamp });
  await chunkedSkuUpdate(supabase, table, dualSkus, {
    [column]: newLabel,
    subcategory_one: newLabel,
    updated_at: stamp,
  });
  return { renamed: dualSkus.length + singleSkus.length };
}

/**
 * Column patch for products under a deleted node:
 * - depth 0: clear category and every subcategory column (covers shallow rows
 *   where subcategory_one duplicates the category label).
 * - depth N: clear column N and everything deeper; category stays intact.
 *
 * category / subcategory_one are NOT NULL in website_stock, so they are
 * cleared to '' (the codebase-wide "uncategorised" representation); deeper
 * columns are nullable and cleared to null.
 */
export function buildClearLabelsPatch(ctx) {
  const patch = {};
  if (ctx.depth === 0) patch.category = '';
  const firstSub = ctx.depth === 0 ? 0 : ctx.depth - 1;
  for (let i = firstSub; i < SUB_COLS.length; i += 1) {
    patch[SUB_COLS[i]] = SUB_COLS[i] === 'subcategory_one' ? '' : null;
  }
  // Deleting a node clears its own position and everything deeper. Positions
  // within subcategory_extra above ctx's own depth are ancestors and must
  // survive — matched rows all share that same ancestor prefix (that's the
  // node-scope match criterion), so it can be derived from ctx alone rather
  // than read per-row. ctx.ancestors[0..3] map onto the fixed columns above;
  // ancestors[4:] map onto subcategory_extra.
  const preservedExtra = (ctx.ancestors || []).slice(SUB_COLS.length + 1).map((a) => a.label);
  patch[EXTRA_COL] = preservedExtra.length ? JSON.stringify(preservedExtra) : null;
  return patch;
}

/**
 * Null out stored labels on every product row (live + archived) under a
 * deleted node, so no phantom category paths survive the delete. Uses the
 * same tolerant matching as rename. Returns rows actually updated.
 */
export async function clearProductsForDeletedNode(supabase, ctx) {
  const { filters } = buildNodeProductFilter(ctx);
  const column = nodeScopeColumn(ctx);
  const patch = { ...buildClearLabelsPatch(ctx), updated_at: new Date().toISOString() };
  let cleared = 0;
  for (const table of ['website_stock', 'archived_products']) {
    const rows = await fetchRowsMatchingNodeScope(supabase, table, { column, filters });
    const skus = rows.map((r) => r.sku).filter(Boolean);
    await chunkedSkuUpdate(supabase, table, skus, patch);
    cleared += skus.length;
  }
  return cleared;
}

/** Tag applied to products archived because their category was deleted. */
export const CATEGORY_DELETED_ARCHIVED_BY = 'category-deleted';

/**
 * When a category/subcategory is deleted, ARCHIVE the live products under it
 * (move website_stock → archived_products via the archive_product RPC),
 * keeping their category labels intact so the admin can find and restore them
 * from the Archive later. Archived copies already under the node are left
 * as-is. Returns the number of live products archived.
 */
export async function archiveProductsForDeletedNode(supabase, ctx, by = CATEGORY_DELETED_ARCHIVED_BY) {
  const { filters } = buildNodeProductFilter(ctx);
  const column = nodeScopeColumn(ctx);
  const rows = await fetchRowsMatchingNodeScope(supabase, 'website_stock', { column, filters });
  const skus = rows.map((r) => r.sku).filter(Boolean);
  let archived = 0;
  const failures = [];
  // Bounded concurrency — a big category is thousands of per-SKU RPCs; a
  // sequential loop would exceed the function timeout.
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < skus.length) {
      const sku = skus[cursor];
      cursor += 1;
      const { error } = await supabase.rpc('archive_product', { p_sku: sku, p_by: by });
      if (error) failures.push({ sku, error: error.message });
      else archived += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, () => worker()));
  return { archived, failures, total: skus.length };
}

export const MOTTARO_DELETED_ARCHIVED_BY = 'mottaro-deleted';

const MOTTARO_SCAN_COLS = 'sku,title,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,subcategory_extra,mottaro_path';

/**
 * Live Motarro product SKUs whose virtual Motarro path passes through `nodeId`
 * (the node being deleted, or any of its descendants). `tree` must be the
 * Motarro-injected tree that STILL contains the node (call before hiding it).
 */
export async function collectMotarroSkusUnderNode(supabase, tree, nodeId) {
  const skus = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select(MOTTARO_SCAN_COLS)
      .order(PAGE_SORT_COLUMN, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data || [];
    for (const row of batch) {
      if (!isMotarroProduct(row)) continue;
      const path = inferMotarroPathFromRow(row, tree);
      if (Array.isArray(path) && path.includes(nodeId) && row.sku) skus.push(row.sku);
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return skus;
}

/** Archive every live Motarro product under a (to-be-deleted) Motarro node. */
export async function archiveMotarroProductsUnderNode(supabase, tree, nodeId, by = MOTTARO_DELETED_ARCHIVED_BY) {
  const skus = await collectMotarroSkusUnderNode(supabase, tree, nodeId);
  let archived = 0;
  const failures = [];
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < skus.length) {
      const sku = skus[cursor];
      cursor += 1;
      const { error } = await supabase.rpc('archive_product', { p_sku: sku, p_by: by });
      if (error) failures.push({ sku, error: error.message });
      else archived += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, () => worker()));
  return { archived, failures, total: skus.length };
}

/** Count rows (live + archived) still carrying the old label under the node scope. */
export async function countRenameOrphans(supabase, ctx, oldLabel, newLabel) {
  if (normalizeLabel(oldLabel) === normalizeLabel(newLabel)) return 0;
  const { column, filters } = buildRenameFilter(ctx, oldLabel);
  let orphans = 0;
  for (const table of ['website_stock', 'archived_products']) {
    const remaining = await fetchRowsMatchingNodeScope(supabase, table, { column, filters });
    orphans += remaining.length;
  }
  return orphans;
}

/** Resolve taxonomy labels from an id path (main + subcategory ids). */
export function resolveLabelsFromPathIds(tree, pathIds = []) {
  const ids = (pathIds || []).filter(Boolean);
  if (!ids.length) throw new Error('Category path is required');
  const labels = [];
  let nodes = tree || [];
  for (const id of ids) {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Unknown category id: ${id}`);
    labels.push(node.label);
    nodes = node.children || [];
  }
  return labels;
}

// Requires migration 038 (mottaro_path) to be applied before deploy.
// sku is selected so additional placements (migration 049) can be joined on.
const COUNT_ROW_COLS = 'sku,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,subcategory_extra,title,available_stock,stock_qty,mottaro_path,keep_live_when_oos';

/**
 * Count live products per taxonomy node (includes all descendants).
 * Default counts every live row so badges match the Product Manager's default
 * view; pass onlyInStock=true to mirror the "Show only in stock" toggle.
 *
 * `placements` is an optional sku -> paths[] Map (see _placements.js). When
 * supplied, a product also counts under every additional placement. Node ids
 * are collected into a Set first, so a product filed under both a category and
 * one of its own descendants counts once per node rather than inflating every
 * shared ancestor. Omit it and the counts are byte-identical to before.
 */
export async function buildCategoryProductCounts(supabase, tree, { onlyInStock = false, placements = null } = {}) {
  const counts = { __uncategorized__: 0, __all__: 0 };
  let mottaroLive = 0;
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select(COUNT_ROW_COLS)
      .order(PAGE_SORT_COLUMN, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data || [];
    for (const row of batch) {
      if (onlyInStock && !isPublishableOnWebsite(row)) continue;
      counts.__all__ += 1;

      const isMottaro = isMotarroProduct(row);
      if (isMottaro) mottaroLive += 1;

      const { categoryPath } = resolveCategoryIds(row, tree);
      if (!categoryPath.length) {
        counts.__uncategorized__ += 1;
      }
      const extraPaths = placements ? (placements.get(row.sku) || []) : [];
      for (const id of collectCountableNodeIds([categoryPath, ...extraPaths])) {
        counts[id] = (counts[id] || 0) + 1;
      }

      if (isMottaro) {
        const mottaroPath = inferMotarroPathFromRow(row, tree);
        for (const id of mottaroPath) {
          counts[id] = (counts[id] || 0) + 1;
        }
      }
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }

  if (mottaroLive > 0) {
    counts.mottaro = Math.max(counts.mottaro || 0, mottaroLive);
  }

  return counts;
}
