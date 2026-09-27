import { describe, expect, it } from 'vitest';
import { normalizeCategoryPathValue } from '../src/components/productLoader/CategoryPathSelect.jsx';

const taxonomy = [{
  id: 'packaging-storage',
  children: [{
    id: 'gifts-wrapping',
    children: [{ id: 'gift-bags', children: [] }],
  }, {
    id: 'packaging-packets-bags',
    children: [{
      id: 'paper-bags',
      children: [{ id: 'boutique', children: [] }],
    }],
  }],
}];

describe('normalizeCategoryPathValue', () => {
  it('removes a stale child retained from a previous category branch', () => {
    expect(normalizeCategoryPathValue(taxonomy, [
      'packaging-storage',
      'gifts-wrapping',
      'gift-bags',
      'boutique',
    ])).toEqual(['packaging-storage', 'gifts-wrapping', 'gift-bags']);
  });

  it('preserves a valid full path', () => {
    expect(normalizeCategoryPathValue(taxonomy, [
      'packaging-storage',
      'packaging-packets-bags',
      'paper-bags',
      'boutique',
    ])).toEqual([
      'packaging-storage',
      'packaging-packets-bags',
      'paper-bags',
      'boutique',
    ]);
  });
});
