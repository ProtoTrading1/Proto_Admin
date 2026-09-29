import { normalizeUnitsOfIssue } from './selling-unit.mjs';

export const MIN_LIVE_INSTORE_AVAILABLE_STOCK = 10;

// Only an exact, complete Positill row may supply stock for an already-GRV'd import.
export function verifiedLiveInstoreStock(row, expectedSku) {
  const source = row?.sqlRow || row || {};
  const sku = String(source.CODE ?? source.code ?? '').trim().toUpperCase();
  if (!sku || sku !== String(expectedSku || '').trim().toUpperCase()) {
    return { blocker: 'Exact live Positill stock is unavailable for this SKU.' };
  }
  const rawUnit = String(source.UNITS ?? source.units_of_issue ?? '').trim();
  if (!rawUnit || /^(?:[-—]|0|N\/?A|UNKNOWN|UNDEFINED)$/i.test(rawUnit)) {
    return { blocker: 'The live Positill selling unit is missing.' };
  }
  const rawOnhand = source.ONHAND ?? source.onhand;
  const rawBooked = source.BOOKED ?? source.booked;
  if (source.stock_fields_verified === false || rawOnhand == null || rawBooked == null || rawOnhand === '' || rawBooked === '') {
    return { blocker: 'The live Positill stock or booked quantity is missing.' };
  }
  const onhand = Number(rawOnhand);
  const booked = Number(rawBooked);
  const available = onhand - booked;
  if (!Number.isSafeInteger(onhand) || !Number.isSafeInteger(booked) || onhand < 0 || booked < 0
    || !Number.isSafeInteger(available) || available < 1) {
    return { blocker: 'No positive whole selling units are available in live Positill stock.' };
  }
  if (available < MIN_LIVE_INSTORE_AVAILABLE_STOCK) {
    return { blocker: `Instore needs at least ${MIN_LIVE_INSTORE_AVAILABLE_STOCK} live available selling units.` };
  }
  return { blocker: '', sku, unitsOfIssue: normalizeUnitsOfIssue(rawUnit), sellableQty: available, onhand, booked };
}
