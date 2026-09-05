/** ERP SKU match candidates — case, leading zeros, Numbers float artifacts. */
export function skuLookupVariants(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const variants = new Set([s, s.toUpperCase(), s.toLowerCase()]);
  if (/^\d+\.0+$/.test(s)) variants.add(s.replace(/\.0+$/, ''));
  const stripped = s.replace(/^0+(?=\d)/, '');
  if (stripped && stripped !== s) {
    variants.add(stripped);
    variants.add(stripped.toUpperCase());
    variants.add(stripped.toLowerCase());
  }
  if (/^\d+$/.test(stripped)) {
    for (const len of [4, 5, 6, 7, 8, 10, 12]) {
      const padded = stripped.padStart(len, '0');
      variants.add(padded);
      variants.add(padded.toUpperCase());
      variants.add(padded.toLowerCase());
    }
  }
  return [...variants];
}

export function collectLookupKeys(values) {
  const keys = new Set();
  for (const value of values) {
    for (const key of skuLookupVariants(value)) keys.add(key);
  }
  return [...keys];
}

export function buildProductLookupMap(products) {
  const map = new Map();
  for (const product of products || []) {
    for (const key of skuLookupVariants(product.sku)) {
      if (!map.has(key)) map.set(key, product);
    }
  }
  return map;
}

export function findProductBySku(lookupMap, raw) {
  if (!lookupMap || !raw) return null;
  for (const key of skuLookupVariants(raw)) {
    const product = lookupMap.get(key);
    if (product) return product;
  }
  return null;
}

export async function fetchProductLookupMap(supabase, rawKeys, cols = 'sku') {
  const queryKeys = collectLookupKeys(rawKeys);
  if (!queryKeys.length) return new Map();
  const products = [];
  for (let i = 0; i < queryKeys.length; i += 500) {
    const chunk = queryKeys.slice(i, i + 500);
    const { data, error } = await supabase.from('products').select(cols).in('sku', chunk);
    if (error) throw error;
    products.push(...(data || []));
  }
  return buildProductLookupMap(products);
}
