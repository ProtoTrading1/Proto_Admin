/** Human-readable order reference for UI, emails, and PDFs. */
export function displayOrderNumber(order) {
  if (!order) return '—';
  const num = order.order_number || order.orderNumber;
  if (num) return String(num);
  if (order.id) return String(order.id).slice(0, 8);
  return '—';
}

export function buildFulfillmentUrl(orderId, origin = '') {
  if (!orderId) return '';
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/fulfillment?id=${encodeURIComponent(orderId)}`;
}
