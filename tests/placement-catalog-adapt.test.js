import { describe, expect, it } from 'vitest';
import { adaptCatalogRow } from '../api/_catalog-adapt.js';

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

const ROW = {
  sku: 'PEN1',
  barcode: '600123',
  title: 'Blue Pen',
  price: 12.5,
  category: 'School & Office',
  subcategory_one: 'Writing',
  subcategory_two: 'Pens',
};

describe('adaptCatalogRow with placements', () => {
  it('is unchanged when no placements are passed', () => {
    const adapted = adaptCatalogRow(ROW, TREE);
    expect(adapted.categoryPath).toEqual(['school-and-office', 'writing', 'pens']);
    expect(adapted.categoryPaths).toEqual([['school-and-office', 'writing', 'pens']]);
    expect(adapted.placementPaths).toEqual([]);
  });

  it('passing an empty placement list matches passing none', () => {
    const none = adaptCatalogRow(ROW, TREE);
    const empty = adaptCatalogRow(ROW, TREE, { placementPaths: [] });
    expect(empty).toEqual(none);
  });

  // categoryPath stays the PRIMARY for back-compat; categoryPaths carries the
  // full set. Existing readers of categoryPath must not change behaviour.
  it('keeps categoryPath as the primary and adds placements to categoryPaths', () => {
    const adapted = adaptCatalogRow(ROW, TREE, {
      placementPaths: [['art-supplies', 'paint']],
    });
    expect(adapted.categoryPath).toEqual(['school-and-office', 'writing', 'pens']);
    expect(adapted.categoryPaths).toEqual([
      ['school-and-office', 'writing', 'pens'],
      ['art-supplies', 'paint'],
    ]);
    expect(adapted.placementPaths).toEqual([['art-supplies', 'paint']]);
  });

  it('does not repeat a placement that equals the primary', () => {
    const adapted = adaptCatalogRow(ROW, TREE, {
      placementPaths: [['school-and-office', 'writing', 'pens'], ['art-supplies', 'paint']],
    });
    expect(adapted.categoryPaths).toEqual([
      ['school-and-office', 'writing', 'pens'],
      ['art-supplies', 'paint'],
    ]);
  });

  it('drops duplicate placements', () => {
    const adapted = adaptCatalogRow(ROW, TREE, {
      placementPaths: [['art-supplies', 'paint'], ['art-supplies', 'paint']],
    });
    expect(adapted.categoryPaths).toHaveLength(2);
  });

  it('still adapts an uncategorised row without inventing a path', () => {
    const adapted = adaptCatalogRow({ ...ROW, category: '', subcategory_one: '', subcategory_two: '' }, TREE);
    expect(adapted.categoryPath).toEqual([]);
    expect(adapted.categoryPaths).toEqual([]);
  });

  it('places an uncategorised row under its placement only', () => {
    const adapted = adaptCatalogRow(
      { ...ROW, category: '', subcategory_one: '', subcategory_two: '' },
      TREE,
      { placementPaths: [['art-supplies', 'paint']] },
    );
    expect(adapted.categoryPath).toEqual([]);
    expect(adapted.categoryPaths).toEqual([['art-supplies', 'paint']]);
  });
});
