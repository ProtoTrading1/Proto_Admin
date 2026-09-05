let _cache = null;
let _loadPromise = null;

export async function fetchSpecials() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  _loadPromise = fetch('/api/specials', { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => { _cache = data; return data; })
    .catch(() => ({ items: [] }))
    .finally(() => { clearTimeout(timeout); _loadPromise = null; });
  return _loadPromise;
}

// NOTE: deliberately does NOT send baseUpdatedAt. Specials auto-saves on every
// field change (un-awaited), so overlapping saves from ONE admin are normal —
// optimistic concurrency here made typing "25" 409 against its own in-flight
// "2" and drop the edit. The server still serializes writes through the CAS
// mutator, which is the protection that matters for this surface. Featured and
// coming-soon keep baseUpdatedAt because they save via an explicit button.
export async function saveSpecials(items) {
  _cache = null;
  const res = await fetch('/api/specials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items.slice(0, 10) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to save specials');
  _cache = json;
  return json;
}

export function invalidateSpecialsCache() {
  _cache = null;
}

export function buildSpecialsMap(data) {
  const map = {};
  for (const item of (data?.items || [])) {
    map[item.productId] = item;
  }
  return map;
}
