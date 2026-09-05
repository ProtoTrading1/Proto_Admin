import { describe, expect, it } from 'vitest';
import { isPlacedOnlyInPath, partitionPlacedOnly } from '../src/lib/placements.js';

const OWNED = { id: 'A', categoryPath: ['homeware', 'storage'], placementPaths: [] };
const PLACED = { id: 'B', categoryPath: ['confectionery', 'coffee-pods'], placementPaths: [['homeware']] };
const BOTH = { id: 'C', categoryPath: ['homeware'], placementPaths: [['homeware']] };

describe('isPlacedOnlyInPath', () => {
  it('is false for a product whose primary lives here', () => {
    expect(isPlacedOnlyInPath(OWNED, ['homeware'])).toBe(false);
  });

  // The data-loss case: bulk move would rewrite this product's real category.
  it('is true for a product that is only here via a placement', () => {
    expect(isPlacedOnlyInPath(PLACED, ['homeware'])).toBe(true);
  });

  it('is false when the primary also matches, even if a placement does too', () => {
    expect(isPlacedOnlyInPath(BOTH, ['homeware'])).toBe(false);
  });

  it('matches a placement deeper than the browsed node', () => {
    const p = { categoryPath: ['a'], placementPaths: [['homeware', 'storage', 'boxes']] };
    expect(isPlacedOnlyInPath(p, ['homeware'])).toBe(true);
  });

  it('does not match a placement shallower than the browsed node', () => {
    const p = { categoryPath: ['a'], placementPaths: [['homeware']] };
    expect(isPlacedOnlyInPath(p, ['homeware', 'storage'])).toBe(false);
  });

  // At the root there is no category to destroy, so nothing is excluded.
  it('is false at the root listing', () => {
    expect(isPlacedOnlyInPath(PLACED, [])).toBe(false);
    expect(isPlacedOnlyInPath(PLACED, null)).toBe(false);
  });

  it('handles products with no placement data', () => {
    expect(isPlacedOnlyInPath({ categoryPath: ['x'] }, ['homeware'])).toBe(false);
    expect(isPlacedOnlyInPath({}, ['homeware'])).toBe(false);
  });
});

describe('partitionPlacedOnly', () => {
  it('separates owned rows from merely-placed rows', () => {
    const { owned, placedOnly } = partitionPlacedOnly([OWNED, PLACED, BOTH], ['homeware']);
    expect(owned.map((p) => p.id)).toEqual(['A', 'C']);
    expect(placedOnly.map((p) => p.id)).toEqual(['B']);
  });

  it('keeps everything when browsing the root', () => {
    const { owned, placedOnly } = partitionPlacedOnly([OWNED, PLACED], []);
    expect(owned).toHaveLength(2);
    expect(placedOnly).toHaveLength(0);
  });
});
