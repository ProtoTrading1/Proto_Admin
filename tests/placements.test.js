import { describe, expect, it } from 'vitest';
import {
  buildPlacementMap,
  collectCountableNodeIds,
  mergeCategoryPaths,
  normalizePlacementPath,
  parsePlacementInput,
  placementPathKey,
  skusMatchingBrowsePath,
} from '../api/_placements.js';

describe('normalizePlacementPath', () => {
  it('accepts a clean array of node ids', () => {
    expect(normalizePlacementPath(['school-and-office', 'writing'])).toEqual([
      'school-and-office',
      'writing',
    ]);
  });

  it('parses the jsonb column arriving as a JSON string', () => {
    expect(normalizePlacementPath('["art-supplies","paint"]')).toEqual(['art-supplies', 'paint']);
  });

  it('trims and drops empty segments', () => {
    expect(normalizePlacementPath([' art-supplies ', '', null, 'paint'])).toEqual([
      'art-supplies',
      'paint',
    ]);
  });

  it('returns null for anything that is not a usable path', () => {
    expect(normalizePlacementPath(null)).toBeNull();
    expect(normalizePlacementPath([])).toBeNull();
    expect(normalizePlacementPath(['', '  '])).toBeNull();
    expect(normalizePlacementPath('not json')).toBeNull();
    expect(normalizePlacementPath({ nope: true })).toBeNull();
  });
});

describe('placementPathKey', () => {
  it('joins segments into a stable key', () => {
    expect(placementPathKey(['a', 'b', 'c'])).toBe('a/b/c');
  });

  it('gives equal keys for equal paths regardless of array identity', () => {
    expect(placementPathKey(['a', 'b'])).toBe(placementPathKey(['a', 'b']));
  });
});

describe('buildPlacementMap', () => {
  it('groups normalized paths by website sku', () => {
    const map = buildPlacementMap([
      { website_sku: 'SKU1', node_path: ['a', 'b'] },
      { website_sku: 'SKU1', node_path: '["c","d"]' },
      { website_sku: 'SKU2', node_path: ['e'] },
    ]);
    expect(map.get('SKU1')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(map.get('SKU2')).toEqual([['e']]);
  });

  it('skips rows with an unusable path or missing sku', () => {
    const map = buildPlacementMap([
      { website_sku: 'SKU1', node_path: [] },
      { website_sku: '', node_path: ['a'] },
      { website_sku: 'SKU1', node_path: ['a'] },
    ]);
    expect(map.get('SKU1')).toEqual([['a']]);
    expect(map.size).toBe(1);
  });

  it('returns an empty map for no rows', () => {
    expect(buildPlacementMap([]).size).toBe(0);
    expect(buildPlacementMap(null).size).toBe(0);
  });
});

describe('mergeCategoryPaths', () => {
  it('puts the primary path first and appends placements', () => {
    expect(mergeCategoryPaths(['a', 'b'], [['c']])).toEqual([['a', 'b'], ['c']]);
  });

  it('drops a placement that duplicates the primary', () => {
    expect(mergeCategoryPaths(['a', 'b'], [['a', 'b'], ['c']])).toEqual([['a', 'b'], ['c']]);
  });

  it('drops duplicate placements', () => {
    expect(mergeCategoryPaths(['a'], [['c'], ['c']])).toEqual([['a'], ['c']]);
  });

  // Uncategorised primary ('' category) must not produce a phantom placement.
  it('omits an empty primary without inventing one', () => {
    expect(mergeCategoryPaths([], [['c']])).toEqual([['c']]);
    expect(mergeCategoryPaths(null, [['c']])).toEqual([['c']]);
  });

  it('returns just the primary when there are no placements', () => {
    expect(mergeCategoryPaths(['a'], [])).toEqual([['a']]);
    expect(mergeCategoryPaths(['a'], null)).toEqual([['a']]);
  });

  it('returns an empty list when there is nothing at all', () => {
    expect(mergeCategoryPaths([], [])).toEqual([]);
  });
});

describe('parsePlacementInput', () => {
  it('accepts a valid body', () => {
    expect(parsePlacementInput({ websiteSku: 'SKU1', nodePath: ['a', 'b'] })).toEqual({
      sku: 'SKU1',
      path: ['a', 'b'],
    });
  });

  it('trims the sku', () => {
    expect(parsePlacementInput({ websiteSku: '  SKU1 ', nodePath: ['a'] }).sku).toBe('SKU1');
  });

  it('rejects a missing sku', () => {
    expect(parsePlacementInput({ nodePath: ['a'] }).error).toMatch(/websiteSku/);
    expect(parsePlacementInput({ websiteSku: '   ', nodePath: ['a'] }).error).toMatch(/websiteSku/);
  });

  it('rejects a missing or empty node path', () => {
    expect(parsePlacementInput({ websiteSku: 'SKU1' }).error).toMatch(/nodePath/);
    expect(parsePlacementInput({ websiteSku: 'SKU1', nodePath: [] }).error).toMatch(/nodePath/);
    expect(parsePlacementInput({ websiteSku: 'SKU1', nodePath: 'nope' }).error).toMatch(/nodePath/);
  });

  it('rejects a null body without throwing', () => {
    expect(parsePlacementInput(null).error).toMatch(/websiteSku/);
  });
});

describe('collectCountableNodeIds', () => {
  it('collects every node id across all paths', () => {
    const ids = collectCountableNodeIds([['a', 'b'], ['c']]);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  // A product filed under both an ancestor and its descendant must count once
  // per node, not twice — otherwise category badges over-report.
  it('counts a shared ancestor only once', () => {
    const ids = collectCountableNodeIds([['a', 'b'], ['a', 'b', 'c']]);
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    expect(ids.size).toBe(3);
  });

  it('handles an empty input', () => {
    expect(collectCountableNodeIds([]).size).toBe(0);
    expect(collectCountableNodeIds(null).size).toBe(0);
  });
});

describe('skusMatchingBrowsePath', () => {
  const map = buildPlacementMap([
    { website_sku: 'A', node_path: ['art-supplies', 'paint'] },
    { website_sku: 'B', node_path: ['art-supplies'] },
    { website_sku: 'C', node_path: ['school-and-office', 'writing'] },
    { website_sku: 'A', node_path: ['school-and-office'] },
  ]);

  it('finds a product placed deeper than the browsed node', () => {
    expect([...skusMatchingBrowsePath(map, ['art-supplies'])].sort()).toEqual(['A', 'B']);
  });

  it('matches an exact placement', () => {
    expect([...skusMatchingBrowsePath(map, ['art-supplies', 'paint'])]).toEqual(['A']);
  });

  // Browsing a child must not surface a product placed only at the parent —
  // same depth rule filterByCategoryPath uses for primary paths.
  it('does not surface a shallower placement when browsing a child', () => {
    expect([...skusMatchingBrowsePath(map, ['school-and-office', 'writing'])]).toEqual(['C']);
  });

  it('returns each sku once even with several matching placements', () => {
    const dupes = buildPlacementMap([
      { website_sku: 'A', node_path: ['art-supplies', 'paint'] },
      { website_sku: 'A', node_path: ['art-supplies', 'brushes'] },
    ]);
    expect([...skusMatchingBrowsePath(dupes, ['art-supplies'])]).toEqual(['A']);
  });

  it('returns nothing for an empty or missing browse path', () => {
    expect(skusMatchingBrowsePath(map, []).size).toBe(0);
    expect(skusMatchingBrowsePath(map, null).size).toBe(0);
  });

  it('returns nothing when the feature is off (null map)', () => {
    expect(skusMatchingBrowsePath(null, ['art-supplies']).size).toBe(0);
  });
});
