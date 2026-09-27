export function normalizeInstoreSku(value) {
  return String(value || '').trim().toUpperCase();
}

export function mainSiteInstoreCodeSet(rows = []) {
  return new Set(
    rows.flatMap((row) => [row?.sku, row?.barcode])
      .map(normalizeInstoreSku)
      .filter(Boolean),
  );
}

/** A landed shipment must not create a second catalogue record for one SKU. */
export function instoreDuplicateBlocker({
  websiteStatus,
  existingOnMainSite,
  existingMainSiteLookupFailed,
  existingInstore,
  existingInstoreLookupFailed,
} = {}) {
  if (existingOnMainSite || String(websiteStatus || '').trim().toLowerCase() === 'live') {
    return 'Already on the main website — not added to Instore.';
  }
  if (existingMainSiteLookupFailed) return 'Could not verify the main website catalogue — refresh the shipment before selecting this item.';
  if (existingInstore) return 'Already in Instore — edit the existing Instore item instead.';
  if (existingInstoreLookupFailed) return 'Could not verify Instore status — refresh the shipment before selecting this item.';
  return '';
}
