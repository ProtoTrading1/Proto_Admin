import { resolveLoaderCustomerPrice } from './catalogue-price.mjs';

export const CATALOGUE_SAFETY_DEFAULTS = Object.freeze({
  priceTolerance: 0.02,
  stockAbsoluteTolerance: 5,
  stockPercentTolerance: 0.20,
  staleAfterHours: 6,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isDoubleVatSignature(candidate, canonical, tolerance = 0.02) {
  const actual = finite(candidate);
  const expected = finite(canonical);
  if (actual == null || expected == null || expected <= 0) return false;
  return Math.abs(actual - (expected * 1.15)) <= tolerance
    && Math.abs(actual - expected) > tolerance;
}

export function evaluateCatalogueValues({
  websitePrice,
  canonicalPrice,
  websiteAvailable,
  canonicalAvailable,
  matched = true,
}, options = {}) {
  const rules = { ...CATALOGUE_SAFETY_DEFAULTS, ...options };
  const issues = [];
  const currentPrice = finite(websitePrice);
  const sourcePrice = finite(canonicalPrice);
  const currentStock = finite(websiteAvailable);
  const sourceStock = finite(canonicalAvailable);

  if (!matched) {
    issues.push({ code: 'unmatched_product', severity: 'warning' });
  }
  if (currentPrice == null || currentPrice <= 0) {
    issues.push({ code: 'zero_or_invalid_price', severity: 'critical' });
  } else if (sourcePrice != null && sourcePrice > 0
    && Math.abs(currentPrice - sourcePrice) > rules.priceTolerance) {
    issues.push({
      code: isDoubleVatSignature(currentPrice, sourcePrice, rules.priceTolerance)
        ? 'double_vat_signature'
        : 'price_mismatch',
      severity: 'critical',
      difference: currentPrice - sourcePrice,
    });
  }

  if (matched && sourceStock != null && currentStock != null) {
    const difference = Math.abs(currentStock - sourceStock);
    const tolerance = Math.max(
      rules.stockAbsoluteTolerance,
      Math.abs(sourceStock) * rules.stockPercentTolerance,
    );
    if (difference > tolerance) {
      issues.push({
        code: 'major_stock_mismatch',
        severity: 'critical',
        difference: currentStock - sourceStock,
      });
    } else if (difference > 0) {
      issues.push({
        code: 'stock_mismatch',
        severity: 'warning',
        difference: currentStock - sourceStock,
      });
    }
  }

  return issues;
}

export function canonicalPublishValues({
  product,
  livePositill,
  positillSource,
  existing,
  submitted = {},
  priceBasis = 'vat_inclusive',
}) {
  const livePrice = positillSource === 'erp_sql' ? finite(livePositill?.price) : null;
  const canonicalPrice = livePrice ?? finite(product?.sell_price);
  const hasCanonicalProduct = Boolean(product || (positillSource === 'erp_sql' && livePositill));
  if (hasCanonicalProduct && (canonicalPrice == null || canonicalPrice <= 0)) {
    return {
      blocked: true,
      code: 'canonical_price_invalid',
      message: 'Publishing blocked because the synchronised ERP customer price is zero or invalid.',
    };
  }

  if (hasCanonicalProduct) {
    const loaderPrice = priceBasis === 'erp_ex_vat'
      ? resolveLoaderCustomerPrice({
        productSellPrice: product?.sell_price,
        websitePrice: existing?.price,
        positillPrice: livePositill?.price,
        positillSource,
      })
      : { price: canonicalPrice, source: 'products.sell_price_incl_vat' };
    return {
      blocked: false,
      price: loaderPrice.price,
      priceSource: loaderPrice.source,
      stockQty: finite(livePositill?.onhand) ?? finite(product?.stock_qty) ?? 0,
      availableStock: finite(livePositill?.available)
        ?? finite(product?.available_stock)
        ?? finite(livePositill?.onhand)
        ?? finite(product?.stock_qty)
        ?? 0,
      corrections: evaluateCatalogueValues({
        websitePrice: submitted.price,
        canonicalPrice: loaderPrice.price,
        websiteAvailable: submitted.availableStock,
        canonicalAvailable: livePositill?.available
          ?? product?.available_stock
          ?? livePositill?.onhand
          ?? product?.stock_qty,
      }).map((issue) => issue.code),
    };
  }

  if (priceBasis === 'erp_ex_vat') {
    const loaderPrice = resolveLoaderCustomerPrice({
      websitePrice: existing?.price,
      positillPrice: submitted.erpPriceExVat,
    });
    if (loaderPrice.price <= 0) {
      return {
        blocked: true,
        code: 'price_required',
        message: 'Publishing blocked because no valid ERP price is available.',
      };
    }
    return {
      blocked: false,
      price: loaderPrice.price,
      priceSource: loaderPrice.source,
      stockQty: finite(submitted.stockQty) ?? finite(existing?.stock_qty) ?? 0,
      availableStock: finite(submitted.availableStock)
        ?? finite(existing?.available_stock)
        ?? finite(submitted.stockQty)
        ?? 0,
      corrections: [],
    };
  }

  const submittedPrice = finite(submitted.price);
  const existingPrice = finite(existing?.price);
  const fallbackPrice = submittedPrice > 0 ? submittedPrice : existingPrice;
  if (fallbackPrice == null || fallbackPrice <= 0) {
    return {
      blocked: true,
      code: 'price_required',
      message: 'Publishing blocked because no valid customer price is available.',
    };
  }
  return {
    blocked: false,
    price: fallbackPrice,
    stockQty: finite(submitted.stockQty) ?? finite(existing?.stock_qty) ?? 0,
    availableStock: finite(submitted.availableStock)
      ?? finite(existing?.available_stock)
      ?? finite(submitted.stockQty)
      ?? 0,
    corrections: [],
  };
}
