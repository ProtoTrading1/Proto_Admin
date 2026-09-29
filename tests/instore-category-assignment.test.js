import { describe, expect, it } from 'vitest';
import {
  GIFT_BAG_CATEGORY_PATH,
  instoreCategoryAssignmentBlocker,
  isGiftBagCategoryPath,
} from '../lib/instore-category-assignment.mjs';

describe('Instore category assignment safety', () => {
  it('accepts Gift Bags at the approved destination', () => {
    expect(isGiftBagCategoryPath(GIFT_BAG_CATEGORY_PATH)).toBe(true);
    expect(instoreCategoryAssignmentBlocker({
      category: 'Packaging & Storage',
      categoryPath: GIFT_BAG_CATEGORY_PATH,
      description: 'GIFT BAG LEAF PRINT',
    })).toBe('');
  });

  it('accepts a valid Gift Bags descendant such as Boutique without moving it to the parent', () => {
    const boutiquePath = [...GIFT_BAG_CATEGORY_PATH, 'Boutique'];
    expect(isGiftBagCategoryPath(boutiquePath)).toBe(true);
    expect(instoreCategoryAssignmentBlocker({
      category: 'Packaging & Storage',
      categoryPath: boutiquePath,
      description: 'BOUTIQUE GIFT BAG 28X33CM',
    })).toBe('');
  });

  it('gives an actionable destination for a Gift Bag on the wrong path', () => {
    expect(instoreCategoryAssignmentBlocker({
      category: 'Packaging & Storage',
      categoryPath: ['Packaging & Storage', 'Packaging Packets & Bags', 'Paper Bags'],
      description: 'GIFT BAG LEAF PRINT',
    })).toContain('Packaging & Storage → Gifts & Wrapping → Gift Bags');
  });

  it('rejects a non-bag item assigned to Gift Bags even when it has a selling unit', () => {
    expect(instoreCategoryAssignmentBlocker({
      category: 'Packaging & Storage',
      categoryPath: GIFT_BAG_CATEGORY_PATH,
      description: 'METAL BEADS 10PCS',
    })).toContain('not identified as a Gift Bag');
  });

  it('requires an explicit destination and matching main category', () => {
    expect(instoreCategoryAssignmentBlocker({ description: 'METAL BEADS 10PCS' })).toContain('Choose an Instore destination');
    expect(instoreCategoryAssignmentBlocker({
      category: 'Jewellery',
      categoryPath: ['Packaging & Storage', 'Gifts & Wrapping', 'Gift Bags'],
      description: 'GIFT BAG LEAF PRINT',
    })).toContain('does not match');
  });
});
