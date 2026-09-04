import { normalizePositillCode } from './productIntelligence';
import { APOLLO_CONNECTED_SOURCE_IDS, APOLLO_SOURCE_IDS, planApolloCatalogSources } from '../../lib/apollo-source-catalog.mjs';

const CODE_TOKEN = /\b[A-Z0-9][A-Z0-9._/-]{4,63}\b/gi;
const CONTEXT_TURNS = 4;
const CONTEXT_TURN_CHARS = 280;
const CONTEXT_TOTAL_CHARS = 1000;
const SOURCE_FAMILIES = APOLLO_SOURCE_IDS;

const hasWriteIntent = (value) => /\b(delete|archive|publish|send|change|edit|update|approve|reject|refund|cancel|move|upload|remove)\b/i.test(value);
const hasPersonalDataIntent = (value) => /\b(email address|phone number|mobile number|street address|customer address|contact details|personal details|named customer|customer name)\b/i.test(value)
  || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
  || /(?:\+?27|0)[\s()-]*\d(?:[\s()-]*\d){8}/.test(value)
  || /\b(?:customer|company|account)\s+(?!(?:attention|interest|activity|analytics|orders?|ordered|ordering|bought|purchased|stock|units?|items?|sales|revenue|views?|count|counts|total|totals|performance|health)\b)(?:named\s+|called\s+|#?[A-Z0-9])/i.test(value)
  || /\b\d{1,5}\s+[A-Z][A-Z .'-]{1,60}\s+(?:street|road|avenue|drive|lane|close|boulevard|way)\b/i.test(value);
const isAmbiguousFollowUp = (value) => /^(?:why|what about them|what changed|why did (?:it|that) change|and them|compare them)[?.!\s]*$/i.test(value.trim());

function cleanContextText(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/(?:\+?27|0)[\s()-]*\d(?:[\s()-]*\d){8}/g, '[phone removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONTEXT_TURN_CHARS);
}

export function buildBoundedContext(turns = []) {
  const normalized = (Array.isArray(turns) ? turns : [])
    .filter((turn) => ['user', 'assistant'].includes(turn?.role))
    .map((turn) => ({
      role: turn.role,
      content: cleanContextText(turn.content),
      sourcePlan: Array.isArray(turn.sourcePlan) ? turn.sourcePlan.filter((source) => SOURCE_FAMILIES.includes(source)) : [],
    }))
    .filter((turn) => turn.content)
    .slice(-CONTEXT_TURNS);
  let remaining = CONTEXT_TOTAL_CHARS;
  return normalized.reverse().reduce((result, turn) => {
    if (remaining <= 0) return result;
    const content = turn.content.slice(0, remaining);
    remaining -= content.length;
    result.unshift({ ...turn, content });
    return result;
  }, []);
}

export function planApolloSources(question, context = []) {
  const value = String(question || '').toLowerCase();
  const buyerRanking = /\b(?:who|which\s+(?:customer|company)|top\s+(?:buyer|customer|company)|biggest\s+(?:buyer|customer|company))\b.*\b(?:bought|buy|purchased|ordered|stock|units|items)\b|\b(?:bought|purchased|ordered)\b.*\b(?:most|highest|largest)\b|\bmost\s+(?:stock|units|items)\b/.test(value);
  if (buyerRanking) return ['orders'];
  const sources = new Set(planApolloCatalogSources(value));
  if (/\b(order|orders|sales|revenue|average order|repeat customer)\b/.test(value)) sources.add('orders');
  if (/\b(view|views|viewed|viewing|duration|attention|category|categories|customer interest|looking at)\b/.test(value)) sources.add('customer_attention');
  if (/\b(search|searches|searched|searching|no results?|zero results?)\b/.test(value)) sources.add('search');
  if (/\b(basket|baskets|abandoned cart|checkout)\b/.test(value)) sources.add('baskets');
  if (/\b(health|healthy|system|backend|bridge|database|vercel|service|offline|down|positill connection)\b|\b(?:website|portal|site|service|system)\s+(?:is\s+)?online\b|\bonline\s+(?:status|health)\b/.test(value)) sources.add('backend_health');
  if (/\b(image|images|photo|photos|processing queue)\b/.test(value)) sources.add('image_processing');
  if (/\b(product|item|sku|barcode|stock|price|positill)\b/.test(value)) sources.add('product_intelligence');
  if (sources.has('product_loader') && !/\b(sku|barcode|stock|price|positill|exact product|product code)\b/.test(value)) sources.delete('product_intelligence');
  if (!sources.size && isAmbiguousFollowUp(value)) {
    const prior = [...context].reverse().find((turn) => Array.isArray(turn.sourcePlan) && turn.sourcePlan.length);
    prior?.sourcePlan.forEach((source) => sources.add(source));
  }
  if (!sources.size) APOLLO_CONNECTED_SOURCE_IDS.filter((source) => source !== 'product_intelligence' && source !== 'team').forEach((source) => sources.add(source));
  return [...sources];
}

export function prepareApolloQuestion(question, turns = []) {
  const exactQuestion = String(question || '').trim();
  const context = buildBoundedContext(turns);
  if (!exactQuestion) return { ok: false, clarification: 'What would you like Apollo to check?' };
  if (exactQuestion.length > 600) return { ok: false, clarification: 'Please shorten the question to 600 characters or fewer.' };
  if (hasWriteIntent(exactQuestion)) return { ok: false, clarification: 'Apollo is read-only. Ask what should be reviewed; it cannot change, send, archive or publish anything.' };
  if (hasPersonalDataIntent(exactQuestion)) return { ok: false, clarification: 'Apollo uses aggregate operational evidence and cannot retrieve personal customer contact details.' };
  if (isAmbiguousFollowUp(exactQuestion) && !context.some((turn) => turn.sourcePlan?.length)) {
    return { ok: false, clarification: 'What result or business area do you mean?' };
  }
  return { ok: true, question: exactQuestion, context, sourcePlan: planApolloSources(exactQuestion, context), mode: 'read_only' };
}

function evidenceNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function extractProductCode(question) {
  const input = String(question ?? '').trim();
  const clean = (token) => token.replace(/[.,;:!?]+$/, '');
  const isDate = (token) => /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})$/.test(token);
  // Explicit identifiers and a code entered alone are intentional lookups.
  const explicit = input.match(/\b(?:code|sku|barcode)\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{1,63})\b/i)?.[1];
  if (explicit && /\d/.test(explicit) && !isDate(clean(explicit))) return normalizePositillCode(clean(explicit));
  const tokens = input.match(CODE_TOKEN) || [];
  const candidate = tokens.find((raw) => {
    const token = clean(raw);
    if (!/\d/.test(token) || isDate(token)) return false;
    if (clean(input) === token) return true;
    if (/^(?:R|ZAR|USD|EUR|GBP)\d+(?:[.,]\d+)?$/i.test(token) || /^\d+[.,]\d+$/.test(token)) return false;
    const start = input.indexOf(raw);
    if (/(?:[$£€]|\bR)\s*$/i.test(input.slice(0, start))) return false;
    if (/^\d+$/.test(token)) {
      // Numbers in sentences are quantities unless a long catalogue code is
      // accompanied by product language. Short numeric SKUs need an explicit label.
      return token.length >= 8 && /\b(?:product|item|stock|price)\b/i.test(input)
        && !/\b(?:above|below|over|under|at least|at most)\s*$/i.test(input.slice(0, start));
    }
    return true;
  });
  return candidate ? normalizePositillCode(candidate.replace(/[.,;:!?]+$/, '')) : '';
}

export function formatApolloMoney(value) {
  const amount = evidenceNumber(value);
  if (amount === null) return 'Not available';
  return amount.toLocaleString('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatApolloNumber(value, suffix = '') {
  const amount = evidenceNumber(value);
  if (amount === null) return 'Not available';
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
  const positillAvailable = evidenceNumber(positill.availableStock) !== null;
  const websiteAvailable = evidenceNumber(website.availableStock) !== null;
  const stockDifference = positillAvailable && websiteAvailable
    ? Number(website.availableStock) - Number(positill.availableStock)
    : null;
  const preferredPrice = evidenceNumber(website.price) ?? evidenceNumber(positill.price);
  const preferredStock = evidenceNumber(positill.availableStock) ?? evidenceNumber(website.availableStock);
  const degraded = Boolean(product?.status?.degraded)
    || !positillAvailable || !websiteAvailable || preferredPrice === null
    || product?.sources?.erp !== 'erp_sql' || !product?.sources?.website;

  let summary = preferredStock === null
    ? `${title}: available stock could not be verified`
    : `${title} has ${formatApolloNumber(preferredStock, ' units')} recorded as available`;
  if (!positillAvailable && websiteAvailable) summary += ' in the website catalogue; Positill stock is unavailable';
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
    confidence: degraded || stockDifference !== 0 ? 'Needs checking' : 'High',
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
