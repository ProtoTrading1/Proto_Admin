export const FEATURED_SOFT_CAP = 60;
export const FEATURED_HARD_CAP = 100;

export async function fetchFeaturedProducts() {
  const res = await fetch('/api/featured-products', { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Failed to load featured products');
  return {
    items: Array.isArray(json.items) ? json.items : [],
    updatedAt: json.updatedAt || null,
  };
}

export async function saveFeaturedProducts(items, baseUpdatedAt = null, baseItems = null) {
  const normalized = (items || []).slice(0, FEATURED_HARD_CAP).map((row) => ({
    sku: String(row.sku || '').trim().toUpperCase(),
    addedAt: row.addedAt || new Date().toISOString(),
  })).filter((row) => row.sku);

  const res = await fetch('/api/featured-products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: normalized,
      ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
      ...(Array.isArray(baseItems) ? { baseItems } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Failed to save featured products');
  return {
    items: json.items || normalized,
    updatedAt: json.updatedAt || new Date().toISOString(),
  };
}
