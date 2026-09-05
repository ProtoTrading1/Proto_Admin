const MAX_ABSOLUTE_PERCENT = 50;
const HIGH_RISK_PERCENT = 15;
const HIGH_RISK_PRODUCT_COUNT = 20;

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function buildPricingPreflight(products, selectedIds, rawPercent) {
  const percent = Number(rawPercent);
  const selected = new Set(selectedIds || []);
  const rows = (products || [])
    .filter((product) => selected.has(product.id))
    .map((product) => {
      const oldPrice = Number(product.price);
      const newPrice = money(oldPrice * (1 + percent / 100));
      return {
        id: product.id,
        code: product.code || product.id,
        name: product.name || product.code || product.id,
        oldPrice,
        newPrice,
        difference: money(newPrice - oldPrice),
      };
    });

  const blockers = [];
  if (!Number.isFinite(percent) || percent === 0) blockers.push('Enter a non-zero percentage.');
  if (Math.abs(percent) > MAX_ABSOLUTE_PERCENT) blockers.push(`A single adjustment cannot exceed ${MAX_ABSOLUTE_PERCENT}%.`);
  if (!rows.length) blockers.push('Select at least one product.');

  const invalidRows = rows.filter((row) => !Number.isFinite(row.oldPrice) || row.oldPrice <= 0 || !Number.isFinite(row.newPrice) || row.newPrice <= 0);
  if (invalidRows.length) blockers.push(`${invalidRows.length} selected product${invalidRows.length === 1 ? ' has' : 's have'} an invalid current or proposed price.`);

  const oldTotal = money(rows.reduce((sum, row) => sum + (Number.isFinite(row.oldPrice) ? row.oldPrice : 0), 0));
  const newTotal = money(rows.reduce((sum, row) => sum + (Number.isFinite(row.newPrice) ? row.newPrice : 0), 0));
  const highRisk = Math.abs(percent) >= HIGH_RISK_PERCENT || rows.length >= HIGH_RISK_PRODUCT_COUNT;
  const confirmationPhrase = highRisk ? `APPLY ${percent}% TO ${rows.length} PRODUCTS` : '';

  return {
    percent,
    rows,
    blockers,
    blocked: blockers.length > 0,
    highRisk,
    confirmationPhrase,
    oldTotal,
    newTotal,
    difference: money(newTotal - oldTotal),
  };
}
