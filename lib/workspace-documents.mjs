export const WORKSPACE_TYPES = Object.freeze(['orders', 'customers', 'suppliers', 'containers', 'buying']);

export const DOCUMENT_CATEGORIES = Object.freeze([
  'general',
  'quote',
  'invoice',
  'payment',
  'contract',
  'shipping',
  'product',
  'image',
  'correspondence',
  'spreadsheet',
  'other',
]);

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT = 100_000;

export const ALLOWED_DOCUMENT_EXTENSIONS = Object.freeze([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'rtf',
  'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'eml',
]);

export const DOCUMENT_ACCEPT = ALLOWED_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');

const TEXT_EXTENSIONS = new Set(['txt', 'csv']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic']);

export function documentExtension(filename = '') {
  const clean = String(filename).trim();
  const index = clean.lastIndexOf('.');
  return index > -1 ? clean.slice(index + 1).toLowerCase() : '';
}

export function validateDocumentFile({ name = '', size = 0 } = {}) {
  const extension = documentExtension(name);
  if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(extension)) {
    return { ok: false, error: 'Unsupported file type. Use a business document, spreadsheet, email or image.' };
  }
  const bytes = Number(size) || 0;
  if (bytes <= 0) return { ok: false, error: 'The selected file is empty.' };
  if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, error: 'Files must be 25 MB or smaller.' };
  return { ok: true, extension };
}

export function defaultDocumentCategory(filename = '') {
  const extension = documentExtension(filename);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'spreadsheet';
  return 'general';
}

export function canExtractDocumentText(filename = '') {
  return TEXT_EXTENSIONS.has(documentExtension(filename));
}

export function safeDocumentFilename(filename = 'document') {
  const normalized = String(filename || 'document')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._,'!&$@=;:+?()\- ]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return normalized || 'document';
}

export function documentVersionGroup(filename = '') {
  return safeDocumentFilename(filename).toLowerCase();
}

export function normalizeDocumentTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source
    .map((tag) => String(tag || '').trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean)
    .map((tag) => tag.slice(0, 40)))]
    .slice(0, 12);
}

export function formatDocumentBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 ** 2)).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
}

export function classifyDocument({ filename = '', text = '', selectedCategory = 'general' } = {}) {
  const haystack = `${filename}\n${String(text || '').slice(0, MAX_EXTRACTED_TEXT)}`.toLowerCase();
  const rules = [
    ['invoice', /\b(invoice|tax invoice|pro forma|proforma)\b/],
    ['quote', /\b(quote|quotation|estimate|pricing proposal)\b/],
    ['payment', /\b(proof of payment|payment advice|remittance|paid|pop)\b/],
    ['contract', /\b(contract|agreement|terms and conditions|service level|sla)\b/],
    ['shipping', /\b(container|bill of lading|packing list|shipment|shipping|freight|vessel|eta)\b/],
    ['correspondence', /\b(from:|to:|subject:|dear |kind regards|email)\b/],
    ['product', /\b(product|catalogue|catalog|sku|barcode|stock code|range)\b/],
  ];
  const inferred = rules.find(([, pattern]) => pattern.test(haystack))?.[0]
    || defaultDocumentCategory(filename);
  const category = selectedCategory !== 'general' ? selectedCategory : inferred;

  const workspaceRules = [
    ['containers', /\b(container|bill of lading|packing list|shipment|shipping|freight|vessel|eta)\b/],
    ['orders', /\b(customer order|sales order|order confirmation|delivery|commitment)\b/],
    ['suppliers', /\b(supplier|vendor|lead time|purchase order|factory)\b/],
    ['customers', /\b(customer|client|account|proof of payment|remittance)\b/],
    ['buying', /\b(buying|replenishment|stock cover|range|cost price|quotation|quote)\b/],
  ];
  const suggestedWorkspace = workspaceRules.find(([, pattern]) => pattern.test(haystack))?.[0]
    || (category === 'shipping' ? 'containers' : category === 'payment' ? 'customers' : category === 'quote' ? 'buying' : 'orders');

  const tags = normalizeDocumentTags([
    category,
    documentExtension(filename),
    /\burgent|immediately|asap|overdue\b/.test(haystack) ? 'urgent' : '',
    /\bsupplier|vendor|factory\b/.test(haystack) ? 'supplier' : '',
    /\bcustomer|client|account\b/.test(haystack) ? 'customer' : '',
    /\bcontainer|shipment|freight\b/.test(haystack) ? 'shipping' : '',
    /\bpayment|paid|remittance\b/.test(haystack) ? 'payment' : '',
  ]);

  const emails = [...new Set(haystack.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])].slice(0, 12);
  const references = [...new Set([...haystack.matchAll(/\b(order|po|invoice|quote|container|sku|barcode)\s*(?:no\.?|number|#|:|-)?\s*([a-z0-9][a-z0-9/-]{3,})/gi)]
    .map((match) => `${match[1].toLowerCase()}:${match[2].toUpperCase()}`))].slice(0, 20);
  const skus = [...new Set(haystack.match(/\b\d{8,13}\b/g) || [])].slice(0, 30);
  const compactText = String(text || '').replace(/\s+/g, ' ').trim();
  const summary = compactText
    ? compactText.slice(0, 260).replace(/\s+\S*$/, compactText.length > 260 ? '…' : '')
    : `${safeDocumentFilename(filename)} classified as ${category}.`;
  const matchedSignals = rules.filter(([, pattern]) => pattern.test(haystack)).length
    + workspaceRules.filter(([, pattern]) => pattern.test(haystack)).length;

  return {
    category,
    tags,
    summary,
    suggestedWorkspace,
    classificationConfidence: Math.min(0.97, text ? 0.62 + (matchedSignals * 0.07) : 0.42),
    detectedEntities: { emails, references, skus },
  };
}
