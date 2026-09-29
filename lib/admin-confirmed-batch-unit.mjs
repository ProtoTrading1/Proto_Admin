import { normalizeReceiptUnit } from './received-stock-unit.mjs';

/**
 * Explicit operator confirmation for one landed-shipment review session.
 * It is deliberately limited to exact numeric SKUs, an explicit Instore
 * destination, and positive PCS-only receipt lines. The UI resets the
 * confirmation when a new folder is chosen, and Positill is never changed.
 */
export function isAdminConfirmedBatchEach({ sku, categoryPath, receiptLines }) {
  if (!/^\d{10}$/.test(String(sku || '').trim())) return false;
  if (!Array.isArray(categoryPath) || !categoryPath.some((label) => String(label || '').trim())) return false;
  if (!Array.isArray(receiptLines) || receiptLines.length === 0) return false;
  return receiptLines.every((line) => Number.isSafeInteger(Number(line?.qty))
    && Number(line.qty) > 0
    && normalizeReceiptUnit(line?.unit) === 'PCS');
}

export function applyAdminConfirmedBatchEach(row, categoryPath, receiptLines, confirmed = false) {
  if (!confirmed || row?.unitsOfIssue || !isAdminConfirmedBatchEach({
    sku: row?.code,
    categoryPath,
    receiptLines,
  })) return row;

  return {
    ...row,
    unitsOfIssue: 'EACH',
    canonicalSellingUnitKnown: true,
    sellingUnitSource: 'admin_confirmed_batch_each',
    warnings: (row.warnings || []).filter((warning) => warning !== 'selling_unit_required'),
  };
}
