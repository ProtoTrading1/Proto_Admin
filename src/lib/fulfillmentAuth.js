/** Only Victor may send confirmed orders back to customers. */
export function isVictorSender(user) {
  if (!user) return false;
  const id = String(user.id || '').trim().toLowerCase();
  const name = String(user.name || '').trim().toLowerCase();
  return id === 'victor' || name === 'victor';
}

export const CUSTOMER_SEND_FORBIDDEN = 'Only Victor can send orders to customers.';
export const PAYMENT_RECEIVED_FORBIDDEN = 'Only Victor can mark payment received.';
