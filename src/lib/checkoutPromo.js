let _cache = null;
let _promise = null;

export async function fetchCheckoutPromo({ force = false } = {}) {
  if (!force && _cache) return _cache;
  if (!force && _promise) return _promise;
  _promise = fetch('/api/checkout-promo', { cache: 'no-store' })
    .then((r) => r.json())
    .then((json) => {
      _cache = json;
      _promise = null;
      return json;
    })
    .catch(() => {
      _promise = null;
      return _cache || { active: false, code: 'PROTO75', percent: 7.5 };
    });
  return _promise;
}

export async function saveCheckoutPromo(payload) {
  const res = await fetch('/api/checkout-promo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to save checkout promo');
  _cache = json;
  return json;
}
