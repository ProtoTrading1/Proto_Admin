import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchFeaturedSave, moveFlatListItem, reorderFlatList } from '../src/components/FeaturedPanel';
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
