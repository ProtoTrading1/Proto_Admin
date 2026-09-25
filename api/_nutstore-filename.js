import { codeLookupCandidates, firstCodeToken } from '../lib/code-normalize.mjs';
import { parseColourVariantFilename } from '../lib/product-colour-variants.mjs';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const SLOT_SUFFIX = /^(?<sku>.+)\.(?<slot>[2-4])$/i;
const NOISE_PATTERNS = [
  /\s+copy$/i,
  /[_\s]+(front|back|side|detail|hero)$/i,
];

/**
 * Nutstore PTR Photos filenames use the same image-slot convention as the
 * local Product Loader: SKU.jpg is slot 1 and SKU.2.jpg through SKU.4.jpg
 * are the remaining slots. Keep the full code too: a real SKU ending in .2
 * must be allowed to win an exact match before it is treated as a slot.
 */
export function parseNutstoreFilename(filename) {
  const raw = String(filename || '').trim();
  const slash = raw.lastIndexOf('/');
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot).trim() : name.trim();

  if (!stem) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'empty_filename' };
  }

  if (dot > 0 && !IMAGE_EXT.test(name.slice(dot))) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'unsupported_extension' };
  }

  let working = stem;
  const duplicate = working.match(/\s*\(\d+\)$/);
  if (duplicate) working = working.replace(/\s*\(\d+\)$/, '').trim();

  let fullWorking = working;
  for (const pattern of NOISE_PATTERNS) fullWorking = fullWorking.replace(pattern, '').trim();
  const fullCode = fullWorking.toUpperCase();

  let imageSlot = 1;
  const slotMatch = working.match(SLOT_SUFFIX);
  if (slotMatch?.groups?.sku) {
    working = String(slotMatch.groups.sku || '').trim();
    imageSlot = Math.min(4, Math.max(1, Number.parseInt(slotMatch.groups.slot || '1', 10) || 1));
  }
  for (const pattern of NOISE_PATTERNS) working = working.replace(pattern, '').trim();

  const displayCode = working;
  const colourVariant = parseColourVariantFilename(name);
  const code = colourVariant?.variantSku || firstCodeToken(working);

  if (code.length < 2) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'sku_too_short' };
  }

  return {
    code,
    fullCode: colourVariant?.variantSku || fullCode,
    displayCode: colourVariant?.variantSku || displayCode,
    imageSlot: colourVariant?.preferredSlot || imageSlot,
    colourVariant: colourVariant || null,
    parseError: null,
    codeCandidates: codeLookupCandidates(working),
  };
}

export function isNutstoreImageName(filename) {
  const raw = String(filename || '').trim();
  const slash = raw.lastIndexOf('/');
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXT.test(name.slice(dot));
}

export function nutstoreBasename(path) {
  const raw = String(path || '').trim();
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}
