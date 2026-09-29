import { normalizeReceiptUnit } from './received-stock-unit.mjs';
import { isGiftBagCategoryPath, isGiftBagDescription } from './instore-category-assignment.mjs';

/**
 * This is an explicit, narrowly scoped admin confirmation for Gift Bags as a
 * product family. It is not a Positill-derived unit and must never be used
 * outside the Gift Bags Instore branch, numeric SKU, gift-bag description,
 * and PCS-only receipt. The category+description rule deliberately persists
 * for future Gift Bags SKUs rather than being tied to one shipment's range.
 */
export function isAdminConfirmedGiftBagEach({ sku, description, categoryPath, receiptLines }) {
  if (!/^\d{10}$/.test(String(sku || '').trim())) return false;
  if (!isGiftBagCategoryPath(categoryPath)) return false;
  if (!isGiftBagDescription(description)) return false;
  if (!Array.isArray(receiptLines) || receiptLines.length === 0) return false;
  return receiptLines.every((line) => Number.isSafeInteger(Number(line?.qty))
    && Number(line.qty) > 0
    && normalizeReceiptUnit(line?.unit) === 'PCS');
}

export function applyAdminConfirmedGiftBagEach(row, categoryPath, receiptLines) {
  const description = row?.description || row?.sqlRow?.description || row?.title || row?.sqlRow?.title || '';
  if (row?.unitsOfIssue || !isAdminConfirmedGiftBagEach({
    sku: row?.code,
    description,
    categoryPath,
    receiptLines,
  })) return row;

  return {
    ...row,
    unitsOfIssue: 'EACH',
    canonicalSellingUnitKnown: true,
    sellingUnitSource: 'admin_confirmed_gift_bag_each',
    warnings: (row.warnings || []).filter((warning) => warning !== 'selling_unit_required'),
  };
}
