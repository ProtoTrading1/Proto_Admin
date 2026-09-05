/**
 * "New order" WhatsApp broadcast to the fulfilment team.
 *
 * Plain fetch is deliberate: src/lib/adminKey.js patches window.fetch to
 * attach the verified admin JWT to every /api/ call, so these read as the
 * other order helpers do.
 */

export async function fetchTeamWhatsappSent(orderIds = []) {
  const ids = orderIds.filter(Boolean);
  if (!ids.length) return {};
  const res = await fetch(`/api/order-team-whatsapp?orderIds=${encodeURIComponent(ids.join(','))}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load WhatsApp status');
  return json.sent || {};
}

export async function sendTeamWhatsapp(orderId) {
  const res = await fetch('/api/order-team-whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) throw new Error(json?.error || 'WhatsApp broadcast failed');
  return json;
}
