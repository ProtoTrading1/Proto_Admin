// Suffix separators. Dots and brackets are included so a supplier code like
// "874788384.BLU" or "874788384(BLU)" still yields the bare base code as a
// fallback candidate — previously only "-" and whitespace did, which made the
// loader too strict on those forms.
const SEPARATOR_SPLIT = /[-/&\s,|;.()[\]]+/;
const HAS_SEPARATOR = /[-/&\s,|;.()[\]]/;

function collapseSeparatorRuns(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/&+/g, '&')
    .replace(/,+/g, ',')
    .replace(/\|+/g, '|')
    .replace(/;+/g, ';')
    .replace(/\.+/g, '.');
}

/**
 * Normalize a raw product code into an array of lookup candidates,
 * ordered from most specific to fallback. Callers try each in order
 * and take the first match. Empty string returns [].
 */
export function codeLookupCandidates(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return [];

  const normalized = collapseSeparatorRuns(trimmed).toUpperCase();
  const candidates = [];
  const seen = new Set();

  const add = (value) => {
    const token = collapseSeparatorRuns(String(value ?? '').trim()).toUpperCase();
    if (!token || seen.has(token)) return;
    seen.add(token);
    candidates.push(token);
  };

  add(normalized);

  // A trailing "(2)" copy marker means a variant of the base code — always try
  // the base so "LSL36(2)" still resolves the parent product LSL36.
  const withoutParenCopy = normalized.replace(/\s*\(\d+\)$/, '').trim();
  if (withoutParenCopy && withoutParenCopy !== normalized) add(withoutParenCopy);

  if (HAS_SEPARATOR.test(trimmed)) {
    for (const token of trimmed.split(SEPARATOR_SPLIT)) {
      // Skip 1-character fragments: splitting on "." now also produces the slot
      // digit from names like "MKT822662.2", and a bare "2" must never be used
      // as a lookup candidate. The full code is always tried first, so a real
      // variant SKU still wins on an exact match.
      if (String(token || '').trim().length < 2) continue;
      add(token);
    }
  }

  return candidates;
}

/**
 * The leading base code, with any variant suffix after a separator removed:
 * "874788384-BLU" / "874788384.BLU" / "874788384(BLU)" -> "874788384".
 * Returns '' when there is no suffix to strip.
 */
export function baseCodeToken(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || !HAS_SEPARATOR.test(trimmed)) return '';
  const [first] = collapseSeparatorRuns(trimmed).toUpperCase().split(SEPARATOR_SPLIT);
  const base = String(first || '').trim();
  if (base.length < 2) return '';
  return base === collapseSeparatorRuns(trimmed).toUpperCase() ? '' : base;
}

/** First meaningful token for display/lookup shortcuts (e.g. Nutstore filenames). */
export function firstCodeToken(raw) {
  const candidates = codeLookupCandidates(raw);
  if (candidates.length > 1) return candidates[1];
  return candidates[0] || '';
}
