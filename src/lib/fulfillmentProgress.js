export async function fetchFulfillmentProgress(orderId) {
  const res = await fetch(`/api/fulfillment-progress?orderId=${encodeURIComponent(orderId)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load progress');
  return json;
}

export async function saveFulfillmentSection({ orderId, userId, userName, categoryId, items, complete = true }) {
  const res = await fetch('/api/fulfillment-progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, userId, userName, categoryId, items, complete }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to save section');
  return json;
}

export async function toggleFulfillmentItem({ orderId, userId, userName, itemKey, checked }) {
  const res = await fetch('/api/fulfillment-progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, userId, userName, itemKey, checked }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update item');
  return json;
}

export async function lookupProductCategories(ids) {
  if (!ids.length) return {};
  const res = await fetch('/api/product-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Product lookup failed');
  return json;
}
