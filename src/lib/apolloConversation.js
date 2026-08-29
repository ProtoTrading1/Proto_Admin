import { normalizePositillCode } from './productIntelligence';

const CODE_TOKEN = /\b[A-Z0-9][A-Z0-9._/-]{4,63}\b/gi;

export function extractProductCode(question) {
  const tokens = String(question ?? '').match(CODE_TOKEN) || [];
  const candidate = tokens.find((token) => /\d/.test(token));
  return candidate ? normalizePositillCode(candidate.replace(/[.,;:!?]+$/, '')) : '';
}

export function formatApolloMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Not available';
  return amount.toLocaleString('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatApolloNumber(value, suffix = '') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Not available';
  return `${amount.toLocaleString('en-ZA')}${suffix}`;
}

export function formatApolloTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Johannesburg',
  }).format(date);
}

export function buildProductAnswer(product, searchedCode) {
  const positill = product?.erp || {};
  const website = product?.website || {};
  const code = product?.code || positill.code || searchedCode;
  const title = positill.title || website.title || 'Product description unavailable';
  const positillAvailable = Number.isFinite(Number(positill.availableStock));
  const websiteAvailable = Number.isFinite(Number(website.availableStock));
  const stockDifference = positillAvailable && websiteAvailable
    ? Number(website.availableStock) - Number(positill.availableStock)
    : null;
  const preferredPrice = website.price ?? positill.price;
  const preferredStock = positill.availableStock ?? website.availableStock;
  const degraded = Boolean(product?.status?.degraded);

  let summary = `${title} has ${formatApolloNumber(preferredStock, ' units')} available`;
  if (preferredPrice !== null && preferredPrice !== undefined) {
    summary += ` and its recorded price is ${formatApolloMoney(preferredPrice)}`;
  }
  summary += '.';
  if (stockDifference !== null && stockDifference !== 0) {
    summary += ` The website figure is ${Math.abs(stockDifference)} unit${Math.abs(stockDifference) === 1 ? '' : 's'} ${stockDifference > 0 ? 'higher' : 'lower'} than Positill.`;
  }
  if (degraded) summary += ' One or more sources are unavailable or using an approved cache, so treat this as incomplete.';

  return {
    code,
    title,
    summary,
    checkedAt: formatApolloTimestamp(product?.generatedAt),
    degraded,
    confidence: degraded ? 'Needs checking' : 'High',
    positill: {
      status: product?.status?.erp || 'not_found',
      source: product?.sources?.erp === 'erp_sql' ? 'Live Positill' : (product?.sources?.erp === 'stmast_cache' ? 'Approved cache' : 'Unavailable'),
      code: positill.code || code,
      title: positill.title || 'Not available',
      price: formatApolloMoney(positill.price),
      stockOnHand: formatApolloNumber(positill.stockOnHand, ' units'),
      booked: formatApolloNumber(positill.booked, ' units'),
      availableStock: formatApolloNumber(positill.availableStock, ' units'),
      department: positill.department || 'Not available',
    },
    website: {
      status: product?.status?.website || 'not_found',
      source: product?.sources?.website ? 'Website catalogue' : 'Unavailable',
      code: website.sku || code,
      title: website.title || 'Not available',
      price: formatApolloMoney(website.price),
      stockOnHand: formatApolloNumber(website.stockOnHand, ' units'),
      availableStock: formatApolloNumber(website.availableStock, ' units'),
      category: Array.isArray(website.categoryPath) && website.categoryPath.length
        ? website.categoryPath.join(' / ')
        : 'Not available',
    },
    stockDifference,
  };
}
