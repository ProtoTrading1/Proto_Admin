import { describe, expect, it } from 'vitest';
import { buildCategoryProductCounts } from '../api/_taxonomy-utils.js';
import { buildPlacementMap } from '../api/_placements.js';

const TREE = [
  {
    id: 'school-and-office',
    label: 'School & Office',
    children: [
      { id: 'writing', label: 'Writing', children: [{ id: 'pens', label: 'Pens', children: [] }] },
    ],
  },
  {
    id: 'art-supplies',
    label: 'Art Supplies',
    children: [{ id: 'paint', label: 'Paint', children: [] }],
  },
];

const ROWS = [
  { sku: 'A', title: 'Blue Pen', category: 'School & Office', subcategory_one: 'Writing', subcategory_two: 'Pens' },
  { sku: 'B', title: 'Red Pen', category: 'School & Office', subcategory_one: 'Writing', subcategory_two: 'Pens' },
  { sku: 'C', title: 'Acrylic Paint', category: 'Art Supplies', subcategory_one: 'Paint' },
];

/** Minimal stand-in for the Supabase client's paged select. */
function fakeStock(rows) {
  return {
    from() {
      return {
        select() { return this; },
        // Paged scans order by sku so pages stay stable while the stock sync
        // writes to the table — see api/_taxonomy-utils.js PAGE_SORT_COLUMN.
        order(column) {
          const sorted = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          return { ...this, range: (from, to) => Promise.resolve({ data: sorted.slice(from, to + 1), error: null }) };
        },
        range(from, to) {
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
    },
  };
}

describe('category counts with placements', () => {
  it('counts primary placements only when the feature is off', async () => {
    const counts = await buildCategoryProductCounts(fakeStock(ROWS), TREE);
    expect(counts.__all__).toBe(3);
    expect(counts['school-and-office']).toBe(2);
    expect(counts.writing).toBe(2);
    expect(counts.pens).toBe(2);
    expect(counts['art-supplies']).toBe(1);
    expect(counts.paint).toBe(1);
  });

  // The back-compat guarantee: an explicitly empty placement map must produce
  // exactly the same numbers as no map at all.
  it('is byte-identical with an empty placement map', async () => {
    const off = await buildCategoryProductCounts(fakeStock(ROWS), TREE);
    const empty = await buildCategoryProductCounts(fakeStock(ROWS), TREE, {
      placements: buildPlacementMap([]),
    });
    expect(empty).toEqual(off);
  });

  it('counts a product under its additional placement too', async () => {
    const placements = buildPlacementMap([
      { website_sku: 'A', node_path: ['art-supplies', 'paint'] },
    ]);
    const counts = await buildCategoryProductCounts(fakeStock(ROWS), TREE, { placements });

    // A is still counted under its primary branch...
    expect(counts.pens).toBe(2);
    expect(counts['school-and-office']).toBe(2);
    // ...and now also under the branch it was placed into.
    expect(counts['art-supplies']).toBe(2);
    expect(counts.paint).toBe(2);
    // Total product count is unchanged — placement is not a new product.
    expect(counts.__all__).toBe(3);
  });

  // Filing a product under both a category and one of its own descendants must
  // not increment the shared ancestors twice.
  it('does not double-count a shared ancestor', async () => {
    const placements = buildPlacementMap([
      { website_sku: 'C', node_path: ['art-supplies'] },
    ]);
    const counts = await buildCategoryProductCounts(fakeStock(ROWS), TREE, { placements });
    expect(counts['art-supplies']).toBe(1);
    expect(counts.paint).toBe(1);
  });

  it('ignores placements for skus that are not in the catalogue', async () => {
    const placements = buildPlacementMap([
      { website_sku: 'GHOST', node_path: ['art-supplies', 'paint'] },
    ]);
    const counts = await buildCategoryProductCounts(fakeStock(ROWS), TREE, { placements });
    expect(counts['art-supplies']).toBe(1);
    expect(counts.__all__).toBe(3);
  });
});
