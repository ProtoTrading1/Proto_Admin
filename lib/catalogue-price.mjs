function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

const VAT_MULTIPLIER = 1.15; // South African VAT, 15%
const WEBSITE_PRICE_STEP = 0.5;

/** Convert an ERP/Positill ex-VAT amount to Proto's .00/.50 website grid. */
export function websitePriceFromExVat(priceExVat) {
  const price = positiveNumber(priceExVat);
  if (price == null) return 0;
  return Math.round((price * VAT_MULTIPLIER) / WEBSITE_PRICE_STEP) * WEBSITE_PRICE_STEP;
}

/** Product Loader's Positill price is an ex-VAT input, not a display price. */
export function customerPriceFromPositill(priceExVat) {
  return websitePriceFromExVat(priceExVat);
}

/**
 * True when a price smells like the ex-VAT figure was captured where the
 * incl-VAT one belongs: the price itself is NOT on Proto's .00/.50 grid, but
 * multiplied by 1.15 it lands on it (allowing for PRICE_A being rounded to
 * cents). Every one of the mispriced products matched this
 * (12.61→14.50, 19.57→22.50, 43.04→49.50, 503.48→579.00) and no
 * correctly captured price does — a legitimate price already sits on the
 * grid, so the first clause excludes it.
 */
export function looksLikeExVatPrice(value) {
  const price = positiveNumber(value);
  if (price == null) return false;
  const cents = Math.round(price * 100);
  if (cents % 50 === 0) return false;
  const inclusive = price * VAT_MULTIPLIER;
  const nearestGridPrice = Math.round(inclusive / WEBSITE_PRICE_STEP) * WEBSITE_PRICE_STEP;
  return Math.abs(inclusive - nearestGridPrice) <= 0.01;
}

/**
 * Resolve Product Loader's website price without adding VAT twice:
 *   1. preserve an established, VAT-inclusive website price
 *   2. repair an established price carrying the ex-VAT fingerprint
 *   3. prefer a freshly fetched live Positill PRICE_A for unpublished products
 *   4. fall back to synchronised/cached ex-VAT prices, visibly labelled
 */
export function resolveLoaderCustomerPrice({
  productSellPrice,
  websitePrice,
  positillPrice,
  positillSource,
} = {}) {
  const establishedWebsitePrice = positiveNumber(websitePrice);
  if (establishedWebsitePrice != null) {
    if (looksLikeExVatPrice(establishedWebsitePrice)) {
      return {
        price: websitePriceFromExVat(establishedWebsitePrice),
        source: 'website_stock.price_ex_vat_repaired',
      };
    }
    return { price: establishedWebsitePrice, source: 'website_stock.price_incl_vat' };
  }

  // For products that are not on the website yet, the live bridge is the
  // freshest authority. products.sell_price and stmast_cache can lag behind
  // Positill, so neither may replace a successfully fetched live PRICE_A.
  const positillCustomerPrice = customerPriceFromPositill(positillPrice);
  if (positillSource === 'erp_sql' && positillCustomerPrice > 0) {
    return {
      price: positillCustomerPrice,
      source: 'positill.live_price_a_ex_vat_converted',
    };
  }

  const synchronisedPrice = positiveNumber(productSellPrice);
  if (synchronisedPrice != null) {
    return {
      price: websitePriceFromExVat(synchronisedPrice),
      source: 'products.sell_price_ex_vat_converted',
    };
  }

  if (positillCustomerPrice > 0) {
    return { price: positillCustomerPrice, source: 'positill.cached_price_a_ex_vat_converted' };
  }

  return { price: 0, source: 'missing' };
}

export function loaderPriceSourceLabel(source) {
  if (source === 'positill.live_price_a_ex_vat_converted') return 'Live Positill';
  if (source === 'website_stock.price_incl_vat') return 'Published website price';
  if (source === 'website_stock.price_ex_vat_repaired') return 'Website price repaired';
  if (source === 'products.sell_price_ex_vat_converted') return 'Synced Positill price';
  if (source === 'positill.cached_price_a_ex_vat_converted') return 'Cached Positill price';
  return 'Price unavailable';
}

export function loaderPriceUsesCachedData(source) {
  return source === 'products.sell_price_ex_vat_converted'
    || source === 'positill.cached_price_a_ex_vat_converted';
}
