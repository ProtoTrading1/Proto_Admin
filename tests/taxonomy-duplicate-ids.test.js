import { describe, expect, it } from 'vitest';
import {
  addSubcategoryNode,
  collectNodeIds,
  findAllNodeContexts,
  findNodeContext,
  renameNodeLabel,
  resolveSingleNode,
  uniqueNodeId,
} from '../api/_taxonomy-utils.js';

/**
 * Shaped like the live tree, which reuses the same size and finish labels
 * under several branches — "Opaque" sits under all three seed-bead sizes.
 */
const DUPLICATED = () => ([
  {
    id: 'beads',
    label: 'Beads',
    children: [
      {
        id: 'seed-beads',
        label: 'Seed Beads',
        children: [
          { id: 'size-6-0', label: 'SIZE: 6/0', children: [{ id: 'opaque', label: 'Opaque', children: [] }] },
          { id: 'size-8-0', label: 'SIZE: 8/0', children: [{ id: 'opaque', label: 'Opaque', children: [] }] },
        ],
      },
    ],
  },
]);

describe('duplicate node ids', () => {
  it('finds every node sharing an id, not just the first', () => {
    const tree = DUPLICATED();
    expect(findAllNodeContexts(tree, 'opaque')).toHaveLength(2);
    // The old lookup silently answers with whichever comes first...
    const first = findNodeContext(tree, 'opaque');
    expect(first.ancestors.map((a) => a.label)).toEqual(['Beads', 'Seed Beads', 'SIZE: 6/0']);
  });

  // The bug: renaming "Opaque" under SIZE: 8/0 renamed the one under SIZE: 6/0
  // instead — the node the admin clicked kept its name while a branch they
  // never opened was renamed and ITS products relabelled.
  it('refuses to rename an ambiguous id rather than picking one', () => {
    const tree = DUPLICATED();
    expect(() => resolveSingleNode(tree, 'opaque')).toThrowError(/shares its internal id/i);
  });

  it('names both offenders so the admin can tell them apart', () => {
    try {
      resolveSingleNode(DUPLICATED(), 'opaque');
      throw new Error('should have refused');
    } catch (err) {
      expect(err.status).toBe(409);
      expect(err.matches).toEqual([
        'Beads › Seed Beads › SIZE: 6/0 › Opaque',
        'Beads › Seed Beads › SIZE: 8/0 › Opaque',
      ]);
    }
  });

  it('resolves an unambiguous id normally', () => {
    const ctx = resolveSingleNode(DUPLICATED(), 'seed-beads');
    expect(ctx.node.label).toBe('Seed Beads');
    expect(ctx.depth).toBe(1);
  });

  it('returns null for an id that is not in the tree', () => {
    expect(resolveSingleNode(DUPLICATED(), 'nope')).toBe(null);
  });
});

describe('adding a subcategory never creates a duplicate id', () => {
  // The cause: the old check looked at SIBLINGS only, so the same label in a
  // second branch produced a second node with the same id.
  it('gives a repeated label a distinct id in a different branch', () => {
    let tree = DUPLICATED().slice(0, 1);
    tree = [{
      id: 'beads',
      label: 'Beads',
      children: [
        { id: 'size-6-0', label: 'SIZE: 6/0', children: [{ id: 'opaque', label: 'Opaque', children: [] }] },
        { id: 'size-8-0', label: 'SIZE: 8/0', children: [] },
      ],
    }];

    const { node, created } = addSubcategoryNode(tree, 'size-8-0', 'Opaque');

    expect(created).toBe(true);
    expect(node.label).toBe('Opaque');
    expect(node.id).toBe('opaque-2');
    // And the tree stays unambiguous, so the new node can be renamed later.
    expect(() => resolveSingleNode(tree, 'opaque-2')).not.toThrow();
    expect(() => resolveSingleNode(tree, 'opaque')).not.toThrow();
  });

  it('still treats the same label under the same parent as already existing', () => {
    const tree = [{ id: 'beads', label: 'Beads', children: [{ id: 'opaque', label: 'Opaque', children: [] }] }];
    const { created, node } = addSubcategoryNode(tree, 'beads', 'opaque');
    expect(created).toBe(false);
    expect(node.id).toBe('opaque');
    expect(tree[0].children).toHaveLength(1);
  });

  it('keeps allocating distinct ids as a label is reused again', () => {
    const tree = [{
      id: 'root',
      label: 'Root',
      children: [
        { id: 'a', label: 'A', children: [] },
        { id: 'b', label: 'B', children: [] },
        { id: 'c', label: 'C', children: [] },
      ],
    }];
    addSubcategoryNode(tree, 'a', 'Gold');
    addSubcategoryNode(tree, 'b', 'Gold');
    addSubcategoryNode(tree, 'c', 'Gold');
    const ids = [...collectNodeIds(tree)];
    expect(ids.filter((i) => i.startsWith('gold'))).toEqual(['gold', 'gold-2', 'gold-3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uniqueNodeId leaves an unused slug alone', () => {
    expect(uniqueNodeId([{ id: 'a', label: 'A', children: [] }], 'b')).toBe('b');
  });
});

describe('renaming an unambiguous node still works', () => {
  it('changes the label and keeps the id stable', () => {
    const tree = [{ id: 'stationery', label: 'Stationary', children: [] }];
    const { oldLabel } = renameNodeLabel(tree, 'stationery', 'Stationery');
    expect(oldLabel).toBe('Stationary');
    expect(tree[0]).toEqual({ id: 'stationery', label: 'Stationery', children: [] });
  });
});
