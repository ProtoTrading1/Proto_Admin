import { normalizeUnitsOfIssue } from './selling-unit.mjs';

/**
 * Convert physical pieces from a supplier receipt to customer-sellable units.
 * The caller must supply an explicit canonical unit—absence is an error so a
 * pack can never silently become EACH.
 */
export function receivedPiecesToSellable(receivedQty, canonicalUnit) {
  const pieces = Number(receivedQty);
  if (!Number.isSafeInteger(pieces) || pieces < 1) {
    throw new Error('Received quantity must be a positive whole number of pieces');
  }
  if (!String(canonicalUnit || '').trim()) {
    throw new Error('Canonical selling unit is required');
  }
  const unit = normalizeUnitsOfIssue(canonicalUnit);
  const match = unit.match(/^(?:PACK|BAG|BOX|SET|CARD) (\d+)$/);
  const unitSize = match ? Number(match[1]) : unit === 'PAIR' ? 2 : unit === 'DOZEN' ? 12 : 1;
  return {
    receivedQty: pieces,
    unitsOfIssue: unit,
    unitSize,
    sellableQty: Math.floor(pieces / unitSize),
    remainder: pieces % unitSize,
  };
}

/**
 * Supplier invoices describe the quantity in the UNIT column.  PKS means the
 * number is already expressed in the customer's selling packs; PCS means it
 * is a physical-piece count and must be converted using Positill's unit.
 */
export function normalizeReceiptUnit(value) {
  const unit = String(value || '').trim().toUpperCase().replace(/\./g, '');
  if (!unit || /^(PCS?|PIECES?|EA|EACH)$/.test(unit)) return 'PCS';
  if (/^(PKS?|PACKS?|PKTS?|PACKETS?)$/.test(unit)) return 'PKS';
  return '';
}

export function receivedInvoiceLinesToSellable(receiptLines, canonicalUnit) {
  const lines = Array.isArray(receiptLines) ? receiptLines : [];
  if (!lines.length) throw new Error('At least one received invoice quantity is required');

  let pieces = 0;
  let packs = 0;
  for (const line of lines) {
    const qty = Number(line?.qty);
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('Received quantity must be a positive whole number');
    const unit = normalizeReceiptUnit(line?.unit);
    if (!unit) throw new Error(`Unsupported supplier receipt unit: ${line?.unit || 'blank'}`);
    if (unit === 'PKS') packs += qty;
    else pieces += qty;
  }

  // PKS is already a sellable quantity. Do not invent a Positill unit merely
  // to restate it; a canonical unit remains required for every PCS conversion.
  if (!pieces && !String(canonicalUnit || '').trim()) {
    return {
      receivedQty: packs,
      receiptLines: lines,
      receivedPieces: 0,
      receivedPacks: packs,
      unitsOfIssue: 'PACK',
      unitSize: null,
      sellableQty: packs,
      remainder: 0,
      receiptAlreadySellable: true,
    };
  }

  const pieceConversion = pieces ? receivedPiecesToSellable(pieces, canonicalUnit) : null;
  const base = pieceConversion || receivedPiecesToSellable(1, canonicalUnit);
  return {
    receivedQty: pieces + packs,
    receiptLines: lines,
    receivedPieces: pieces,
    receivedPacks: packs,
    unitsOfIssue: base.unitsOfIssue,
    unitSize: base.unitSize,
    sellableQty: packs + (pieceConversion?.sellableQty || 0),
    remainder: pieceConversion?.remainder || 0,
    receiptAlreadySellable: !pieces && packs > 0,
  };
}
