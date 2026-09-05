/** Stock helpers for website catalogue publish rules. */

export function readStockOnHand(row) {
  const read = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  const available = read(row?.available_stock);
  const raw = read(row?.stock_qty);
  return available !== null ? available : raw;
}

/** True when SOH is exactly 0 (not negative, not unknown). */
export function isExactlyZeroStock(row) {
  return readStockOnHand(row) === 0;
}

/** Negative SOH — kept visible on the trade site per business rule. */
export function isNegativeStock(row) {
  const soh = readStockOnHand(row);
  return soh !== null && soh < 0;
}

/**
 * Live on register.proto.co.za — exclude exact zero only, unless the row is
 * flagged keep_live_when_oos. Negative SOH stays live (business rule).
 * This is the canonical availability rule — the portal's isProductAvailable
 * must agree with it or the two sites show different catalogues.
 */
export function isPublishableOnWebsite(row) {
  if (row?.keep_live_when_oos || row?.keepLiveWhenOos) return true;
  return !isExactlyZeroStock(row);
}
