import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addFeaturedItemToTop,
  canEditFeaturedList,
  dispatchFeaturedSave,
  filterFeaturedProducts,
  hasFeaturedChanges,
  moveFlatListItem,
  moveFlatListItemToTop,
  reorderFlatList,
} from '../src/components/FeaturedPanel';
import { saveFeaturedProducts } from '../src/lib/featuredProducts';

const products = [
  { id: 'A', sku: 'A' },
  { id: 'B', sku: 'B' },
  { id: 'C', sku: 'C' },
  { id: 'D', sku: 'D' },
];

describe('featured storefront order grid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves a dragged product to the hovered storefront position', () => {
    expect(reorderFlatList(products, 'A', 'C').map((item) => item.sku))
      .toEqual(['B', 'C', 'A', 'D']);
    expect(reorderFlatList(products, 'D', 'B').map((item) => item.sku))
      .toEqual(['A', 'D', 'B', 'C']);
  });

  it('supports bounded keyboard and button nudging without losing products', () => {
    expect(moveFlatListItem(products, 'B', 1).map((item) => item.sku))
      .toEqual(['A', 'C', 'B', 'D']);
    expect(moveFlatListItem(products, 'A', -1)).toBe(products);
    expect(moveFlatListItem(products, 'D', 10)).toBe(products);
  });

  it('leaves the order untouched for invalid drag targets', () => {
    expect(reorderFlatList(products, 'A', 'A')).toBe(products);
    expect(reorderFlatList(products, 'missing', 'B')).toBe(products);
  });

  it('moves any featured product straight to the top without losing its neighbours', () => {
    expect(moveFlatListItemToTop(products, 'D').map((item) => item.sku))
      .toEqual(['D', 'A', 'B', 'C']);
    expect(moveFlatListItemToTop(products, 'B').map((item) => item.sku))
      .toEqual(['B', 'A', 'C', 'D']);
    expect(moveFlatListItemToTop(products, 'A')).toBe(products);
    expect(moveFlatListItemToTop(products, 'missing')).toBe(products);
  });

  it('finds featured products by title, SKU or code without changing their saved order', () => {
    const searchable = [
      { id: 'A', sku: 'SKU-A', code: '10001', name: 'Blue Gift Bag' },
      { id: 'B', sku: 'SKU-B', code: '20002', name: 'Red Ribbon' },
      { id: 'C', sku: 'SPECIAL-C', code: '30003', name: 'Green Beads' },
    ];

    expect(filterFeaturedProducts(searchable, 'gift')).toEqual([searchable[0]]);
    expect(filterFeaturedProducts(searchable, 'sku-b')).toEqual([searchable[1]]);
    expect(filterFeaturedProducts(searchable, '30003')).toEqual([searchable[2]]);
    expect(filterFeaturedProducts(searchable, '  ')).toBe(searchable);
  });

  it('adds a catalogue product directly to the top without duplicating products', () => {
    const items = [
      { sku: 'A', addedAt: '2026-08-27T09:00:00.000Z' },
      { sku: 'B', addedAt: '2026-08-27T09:01:00.000Z' },
    ];
    const added = addFeaturedItemToTop(items, ' c ', '2026-08-27T10:00:00.000Z');

    expect(added.map((item) => item.sku)).toEqual(['C', 'A', 'B']);
    expect(addFeaturedItemToTop(items, 'A')).toBe(items);
    expect(addFeaturedItemToTop(items, '')).toBe(items);
  });

  it('simulates preview edits without calling the live save path', () => {
    const onPreview = vi.fn();
    const onLive = vi.fn();

    expect(dispatchFeaturedSave({ previewSimulation: true, items: products, onPreview, onLive }))
      .toBe('preview');
    expect(onPreview).toHaveBeenCalledWith(products);
    expect(onLive).not.toHaveBeenCalled();
  });

  it('keeps the production save path unchanged', () => {
    const onPreview = vi.fn();
    const onLive = vi.fn();

    expect(dispatchFeaturedSave({ previewSimulation: false, items: products, onPreview, onLive }))
      .toBe('live');
    expect(onLive).toHaveBeenCalledWith(products);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('waits for one deliberate save after adding, removing or reordering products', () => {
    expect(hasFeaturedChanges(products, products)).toBe(false);
    expect(hasFeaturedChanges(products, [products[1], products[0], products[2], products[3]])).toBe(true);
    expect(hasFeaturedChanges(products, products.slice(0, 3))).toBe(true);
    expect(hasFeaturedChanges(products, [...products, { id: 'E', sku: 'E' }])).toBe(true);
  });

  it('blocks editing when the existing list has no verified save token', () => {
    expect(canEditFeaturedList({ isSuccess: false, updatedAt: null })).toBe(false);
    expect(canEditFeaturedList({ isSuccess: true, updatedAt: null })).toBe(false);
    expect(canEditFeaturedList({ isSuccess: true, updatedAt: '2026-08-27T10:00:00.000Z' })).toBe(true);
  });

  it('persists the exact visual sequence consumed by the live portal', async () => {
    const fetchMock = vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({ items: JSON.parse(options.body).items, updatedAt: '2026-08-20T13:28:00.000Z' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await saveFeaturedProducts([
      { sku: 'third', addedAt: '2026-08-20T13:00:00.000Z' },
      { sku: 'first', addedAt: '2026-08-20T13:01:00.000Z' },
      { sku: 'second', addedAt: '2026-08-20T13:02:00.000Z' },
    ]);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.items.map((item) => item.sku)).toEqual(['THIRD', 'FIRST', 'SECOND']);
  });
});
