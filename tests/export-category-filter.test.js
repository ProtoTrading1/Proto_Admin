import { describe, expect, it } from 'vitest';
import { applyPathFilter, setLiveTaxonomyTree } from '../src/lib/products';

/**
 * The category-scoped Excel export must select exactly the products the
 * Product Manager grid is showing. It used to run its own inline prefix
 * comparison over `product.categoryPath`, which disagrees with the grid's
 * matcher in ways that silently drop or admit rows.
 */

const TREE = [
  {
    id: 'stationery',
    label: 'Stationery',
    children: [
      { id: 'pens', label: 'Pens', children: [] },
      { id: 'paper', label: 'Paper', children: [] },
    ],
  },
  { id: 'art', label: 'Art', children: [] },
];

/** What the inline filter in exportProductsCatalogXlsx used to do. */
function legacyInlineFilter(products, categoryPath) {
  const want = (categoryPath || []).map(String).filter(Boolean);
  if (!want.length) return products;
  return products.filter((p) => {
    const path = (Array.isArray(p.categoryPath) ? p.categoryPath : []).map(String);
    return want.every((id, i) => path[i] === id);
  });
}

describe('category-scoped export', () => {
  it('keeps a product whose stored path is shallower than the selected path', () => {
    setLiveTaxonomyTree([]); // force the id-prefix branch, tree unavailable
    const products = [{ sku: 'A', categoryPath: ['stationery'], categoryLabel: 'Stationery' }];

    // Selecting Stationery > Pens. The grid's matcher tolerates a product
    // recorded only against the main category; the inline filter dropped it,
    // because want[1] ('pens') had no counterpart in the product's path.
    expect(legacyInlineFilter(products, ['stationery', 'pens'])).toHaveLength(0);
    expect(applyPathFilter(products, ['stationery', 'pens'])).toHaveLength(1);
  });

  it('matches on the taxonomy tree, not raw id equality, when the tree is loaded', () => {
    setLiveTaxonomyTree(TREE);
    // A row carrying the category as a LABEL rather than an id — the shape
    // several loader paths produce. Raw id comparison never matches it.
    const products = [{ sku: 'B', categoryPath: ['Stationery'], categoryLabel: 'Stationery' }];

    expect(legacyInlineFilter(products, ['stationery'])).toHaveLength(0);
    expect(applyPathFilter(products, ['stationery'])).toHaveLength(1);
  });

  it('passes everything through when no category is selected', () => {
    setLiveTaxonomyTree(TREE);
    const products = [
      { sku: 'A', categoryPath: ['stationery'], categoryLabel: 'Stationery' },
      { sku: 'B', categoryPath: ['art'], categoryLabel: 'Art' },
    ];
    expect(applyPathFilter(products, [])).toHaveLength(2);
  });
});
