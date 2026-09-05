export async function fetchFulfillmentUsers() {
  const res = await fetch('/api/fulfillment-users');
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load fulfillment users');
  return json.users || [];
}

export async function saveFulfillmentUsers(users) {
  const res = await fetch('/api/fulfillment-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to save fulfillment users');
  return json.users || [];
}

export const ACTIVE_USER_KEY = 'proto_ff_active_user';

export function loadActiveUserId() {
  try { return localStorage.getItem(ACTIVE_USER_KEY) || ''; } catch { return ''; }
}

export function saveActiveUserId(id) {
  try { localStorage.setItem(ACTIVE_USER_KEY, id); } catch {}
}
