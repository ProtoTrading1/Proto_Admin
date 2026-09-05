import { codeLookupCandidates } from './code-normalize.mjs';

/** Collect SKU/barcode tokens that must never appear as a catalogue title/description. */
export function codeTokensForItem(item = {}) {
  const tokens = new Set();
  for (const raw of [
    item.code,
    item.displayCode,
    item.barcode,
    item.sqlRow?.code,
    item.websiteRow?.sku,
    item.websiteRow?.barcode,
  ]) {
    for (const t of codeLookupCandidates(raw)) tokens.add(t);
  }
  return tokens;
}

function isCodeLikeText(text, codeTokens) {
  const t = String(text ?? '').trim().toUpperCase();
  return Boolean(t && codeTokens.has(t));
}

/** Real catalogue title only — never the barcode/SKU/compound code string. */
export function catalogueDisplayTitle(item = {}) {
  const codeTokens = codeTokensForItem(item);
  for (const raw of [
    item.title,
    item.sqlRow?.title,
    item.websiteRow?.title,
  ]) {
    const t = String(raw ?? '').trim();
    if (!t || isCodeLikeText(t, codeTokens)) continue;
    return t;
  }
  return '';
}

/** Description for archive/publish — never falls back to code or barcode. */
export function catalogueDescription(item = {}) {
  const codeTokens = codeTokensForItem(item);
  for (const raw of [
    item.description,
    item.websiteRow?.original_description,
    item.sqlRow?.title,
    item.title,
  ]) {
    const t = String(raw ?? '').trim();
    if (!t || isCodeLikeText(t, codeTokens)) continue;
    return t;
  }
  return '';
}

/** Label for code column — prefer full filename stem (compound) over matched ERP sku. */
export function loaderCodeLabel(item = {}) {
  return String(item.displayCode || item.code || '').trim();
}
