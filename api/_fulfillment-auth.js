/** Only Victor may send confirmed orders back to customers. */
export function isVictorSender({ userId, name } = {}) {
  const id = String(userId || '').trim().toLowerCase();
  const n = String(name || '').trim().toLowerCase();
  return id === 'victor' || n === 'victor';
}

/**
 * A fulfillment URL grants scoped packing access for one order. It is never a
 * staff identity and therefore cannot perform customer-facing or financial
 * workflow actions.
 */
export function isFulfillmentLinkRestrictedTarget(target) {
  const normalized = String(target || '').trim().toLowerCase();
  return normalized === 'order sent' || normalized === 'payment received';
}

export const CUSTOMER_SEND_FORBIDDEN = 'Only Victor can send orders to customers.';
export const PAYMENT_RECEIVED_FORBIDDEN = 'Only Victor can mark payment received.';
