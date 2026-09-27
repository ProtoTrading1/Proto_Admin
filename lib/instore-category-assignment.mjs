export const GIFT_BAG_CATEGORY_PATH = Object.freeze([
  'Packaging & Storage',
  'Gifts & Wrapping',
  'Gift Bags',
]);

function normalized(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isGiftBagDescription(value) {
  return /\b(?:gift|wine)\s*bags?\b/i.test(String(value || ''));
}

export function isGiftBagCategoryPath(categoryPath) {
  return Array.isArray(categoryPath)
    && categoryPath.length >= GIFT_BAG_CATEGORY_PATH.length
    && GIFT_BAG_CATEGORY_PATH.every((label, index) => normalized(categoryPath[index]) === normalized(label));
}

/**
 * Validate the explicit Instore destination for a single selected product.
 *
 * General taxonomy placement remains an admin decision. Gift Bags are the one
 * product family with an approved category-derived EACH rule, so they fail
 * closed in both directions: bags must use the Gift Bags destination or one
 * of its explicit descendants (for example Boutique), and that branch may
 * not receive a product whose live description is not a Gift Bag or Wine Bag.
 */
export function instoreCategoryAssignmentBlocker({ category = '', categoryPath, description = '' } = {}) {
  const labels = Array.isArray(categoryPath)
    ? categoryPath.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!labels.length) return 'Choose an Instore destination before selecting this SKU.';
  if (category && normalized(category) !== normalized(labels[0])) {
    return 'The Instore category does not match the selected destination path.';
  }

  const giftBag = isGiftBagDescription(description);
  const giftBagPath = isGiftBagCategoryPath(labels);
  if (giftBag && !giftBagPath) {
    return `Choose ${GIFT_BAG_CATEGORY_PATH.join(' → ')} for this Gift Bag.`;
  }
  if (giftBagPath && !giftBag) {
    return 'This SKU is not identified as a Gift Bag or Wine Bag. Choose its correct Instore destination.';
  }
  return '';
}
