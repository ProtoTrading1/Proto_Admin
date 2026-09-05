import { describe, expect, it } from 'vitest';
import {
  buildCategoryProductCounts,
  buildRenameFilter,
  countRenameOrphans,
  findNodeContext,
  renameNodeLabel,
  renameNodeLabelInProducts,
} from '../api/_taxonomy-utils.js';

const TREE = () => ([
  {
    id: 'beads',
    label: 'Beads',
    children: [
      { id: 'glass-beads', label: 'Glass Beads', children: [] },
      { id: 'seed-beads', label: 'Seed Beads', children: [] },
    ],
  },
  { id: 'jewellery', label: 'Jewellery', children: [{ id: 'chains', label: 'Chains', children: [] }] },
]);

/**
 * Stand-in for the Supabase client that reproduces the parts of PostgREST the
 * rename depends on: an ilike-filtered paged select and a chunked update
 * filtered by `sku in (...)`.
 *
 * `onPageRead` fires after each page is served, so a test can simulate the
 * stock sync writing to the table mid-scan — the case that matters, because
 * an UPDATE rewrites the row at the end of the heap and an unordered
 * LIMIT/OFFSET scan then serves a shifted window.
 */
function fakeStock(rowsByTable, { pageSize = 1000, onPageRead = null } = {}) {
  const state = new Map(Object.entries(rowsByTable).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const stats = { pages: 0, updateCalls: 0 };

  function builder(table) {
    const q = {
      table, ilikeCol: null, ilikePattern: null, patch: null,
      inCol: null, inValues: null, orderCol: null,
    };
    const api = {
      select() { return api; },
      ilike(col, pattern) { q.ilikeCol = col; q.ilikePattern = pattern; return api; },
      order(col, { ascending = true } = {}) {
        if (!ascending) throw new Error('fake client only models ascending order');
        q.orderCol = col;
        return api;
      },
      update(patch) { q.patch = patch; return api; },
      in(col, values) {
        q.inCol = col;
        q.inValues = values;
        stats.updateCalls += 1;
        const set = new Set(values);
        for (const row of state.get(table)) {
          if (set.has(row[q.inCol])) Object.assign(row, q.patch);
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq(col, value) {
        for (const row of state.get(table)) {
          if (row[col] === value) Object.assign(row, q.patch);
        }
        return Promise.resolve({ data: null, error: null });
      },
      range(from, to) {
        const needle = String(q.ilikePattern || '').replace(/^%|%$/g, '').toLowerCase();
        let matched = q.ilikeCol
          ? state.get(table).filter((r) => String(r[q.ilikeCol] ?? '').toLowerCase().includes(needle))
          : [...state.get(table)];
        // Modelled the way Postgres behaves: rows come back in HEAP order
        // unless the query asked for an ORDER BY.
        if (q.orderCol) {
          matched = [...matched].sort((a, b) => String(a[q.orderCol]).localeCompare(String(b[q.orderCol])));
        }
        const page = matched.slice(from, to + 1).map((r) => ({ ...r }));
        stats.pages += 1;
        stats.ordered = Boolean(q.orderCol);
        if (onPageRead) onPageRead({ state, page: stats.pages, table });
        return Promise.resolve({ data: page, error: null });
      },
    };
    return api;
  }

  return { from: (table) => builder(table), __state: state, __stats: stats, __pageSize: pageSize };
}

const rowsOf = (client, table) => client.__state.get(table);

describe('renaming a main (top-level) category', () => {
  it('renames the category column on every product under it', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const client = fakeStock({
      website_stock: [
        { sku: 'A', category: 'Beads', subcategory_one: 'Glass Beads' },
        { sku: 'B', category: 'Beads', subcategory_one: 'Seed Beads' },
        { sku: 'C', category: 'Jewellery', subcategory_one: 'Chains' },
      ],
    });

    const result = await renameNodeLabelInProducts(client, 'website_stock', ctx, 'Beads', 'Beadwork');

    expect(result.renamed).toBe(2);
    const rows = rowsOf(client, 'website_stock');
    expect(rows.find((r) => r.sku === 'A').category).toBe('Beadwork');
    expect(rows.find((r) => r.sku === 'B').category).toBe('Beadwork');
    // A different main category is untouched.
    expect(rows.find((r) => r.sku === 'C').category).toBe('Jewellery');
  });

  it('also rewrites subcategory_one on shallow rows that duplicate the category', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'jewellery');
    const client = fakeStock({
      website_stock: [
        { sku: 'A', category: 'Jewellery', subcategory_one: 'Jewellery' },
        { sku: 'B', category: 'Jewellery', subcategory_one: 'Chains' },
      ],
    });

    await renameNodeLabelInProducts(client, 'website_stock', ctx, 'Jewellery', 'Jewelry');

    const rows = rowsOf(client, 'website_stock');
    expect(rows.find((r) => r.sku === 'A')).toMatchObject({ category: 'Jewelry', subcategory_one: 'Jewelry' });
    // A row with a real subcategory keeps it.
    expect(rows.find((r) => r.sku === 'B')).toMatchObject({ category: 'Jewelry', subcategory_one: 'Chains' });
  });

  it('matches labels stored with case or whitespace drift', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const client = fakeStock({
      website_stock: [
        { sku: 'A', category: ' Beads ', subcategory_one: 'Glass Beads' },
        { sku: 'B', category: 'beads', subcategory_one: 'Seed Beads' },
      ],
    });

    const result = await renameNodeLabelInProducts(client, 'website_stock', ctx, 'Beads', 'Beadwork');

    expect(result.renamed).toBe(2);
    expect(rowsOf(client, 'website_stock').every((r) => r.category === 'Beadwork')).toBe(true);
  });

  // The regression this file exists for: a main category is the only kind big
  // enough to need more than one page, and the paged scan had no ORDER BY.
  it('renames every product when the category spans more than one page', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const rows = Array.from({ length: 1356 }, (_, i) => ({
      sku: `BEAD-${String(i).padStart(4, '0')}`,
      category: 'Beads',
      subcategory_one: 'Glass Beads',
    }));
    const client = fakeStock({ website_stock: rows });

    const result = await renameNodeLabelInProducts(client, 'website_stock', ctx, 'Beads', 'Beadwork');

    expect(result.renamed).toBe(1356);
    expect(rowsOf(client, 'website_stock').filter((r) => r.category === 'Beads')).toHaveLength(0);
  });

  // The stock bridge writes prices and stock into website_stock continuously.
  // An UPDATE rewrites the row at the end of the heap, so an unordered
  // LIMIT/OFFSET scan serves a shifted second page and silently skips rows.
  it('renames every product even when the stock sync writes between pages', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const rows = Array.from({ length: 1356 }, (_, i) => ({
      sku: `BEAD-${String(i).padStart(4, '0')}`,
      category: 'Beads',
      subcategory_one: 'Glass Beads',
    }));
    const client = fakeStock({ website_stock: rows }, {
      onPageRead({ state, page, table }) {
        if (page !== 1 || table !== 'website_stock') return;
        // Simulate a price sync touching the first row: Postgres moves the
        // updated tuple to the end of the heap.
        const list = state.get(table);
        const [moved] = list.splice(0, 1);
        list.push(moved);
      },
    });

    const result = await renameNodeLabelInProducts(client, 'website_stock', ctx, 'Beads', 'Beadwork');

    const leftBehind = rowsOf(client, 'website_stock').filter((r) => r.category === 'Beads');
    expect(leftBehind).toHaveLength(0);
    expect(result.renamed).toBe(1356);
    // The guarantee above only holds because the scan is ordered — assert it
    // directly so a refactor cannot quietly drop the ORDER BY again.
    expect(client.__stats.ordered).toBe(true);
  });

  it('reports the products a partial rename left on the old label', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const client = fakeStock({
      website_stock: [
        { sku: 'A', category: 'Beads', subcategory_one: 'Glass Beads' },
        { sku: 'B', category: 'Beadwork', subcategory_one: 'Seed Beads' },
      ],
      archived_products: [],
    });

    const orphans = await countRenameOrphans(client, ctx, 'Beads', 'Beadwork');

    expect(orphans).toBe(1);
  });

  it('treats a no-op rename as having no orphans', async () => {
    const tree = TREE();
    const ctx = findNodeContext(tree, 'beads');
    const client = fakeStock({ website_stock: [], archived_products: [] });
    expect(await countRenameOrphans(client, ctx, 'Beads', ' beads ')).toBe(0);
  });
});

// The same unordered-pagination hazard applies to the full-table scan behind
// the category count badges: website_stock is well over one page, so a write
// mid-scan used to make a category under- or over-count.
describe('category product counts across page boundaries', () => {
  it('counts every product even when the stock sync writes between pages', async () => {
    const tree = TREE();
    // Two categories, split exactly across the page boundary, so a shifted
    // second page double-counts one and loses one instead of cancelling out.
    const rows = Array.from({ length: 1200 }, (_, i) => (i < 1000
      ? { sku: `S-${String(i).padStart(4, '0')}`, category: 'Beads', subcategory_one: 'Glass Beads' }
      : { sku: `S-${String(i).padStart(4, '0')}`, category: 'Jewellery', subcategory_one: 'Chains' }));
    const client = fakeStock({ website_stock: rows }, {
      onPageRead({ state, page, table }) {
        if (page !== 1) return;
        const list = state.get(table);
        list.push(list.shift());
      },
    });

    const counts = await buildCategoryProductCounts(client, tree);

    expect(counts.__all__).toBe(1200);
    expect(counts.beads).toBe(1000);
    expect(counts.jewellery).toBe(200);
  });
});

describe('rename filters', () => {
  it('scopes a main-category rename to the category column alone', () => {
    const ctx = findNodeContext(TREE(), 'beads');
    expect(buildRenameFilter(ctx, 'Beads')).toEqual({
      column: 'category',
      filters: { category: 'Beads' },
    });
  });

  it('scopes a subcategory rename under its parent category', () => {
    const ctx = findNodeContext(TREE(), 'glass-beads');
    expect(buildRenameFilter(ctx, 'Glass Beads')).toEqual({
      column: 'subcategory_one',
      filters: { category: 'Beads', subcategory_one: 'Glass Beads' },
    });
  });

  it('keeps node ids stable across a rename so saved paths still resolve', () => {
    const tree = TREE();
    const { oldLabel } = renameNodeLabel(tree, 'beads', 'Beadwork');
    expect(oldLabel).toBe('Beads');
    expect(tree.find((n) => n.id === 'beads').label).toBe('Beadwork');
  });
});
