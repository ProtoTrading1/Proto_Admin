import { codeLookupCandidates, firstCodeToken } from '../lib/code-normalize.mjs';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const SLOT_SUFFIX = /^(?<sku>.+)\.(?<slot>[2-4])$/i;
const NOISE_PATTERNS = [
  /\s+copy$/i,
  /\s*\(\d+\)$/,
  /[_\s]+(front|back|side|detail|hero)$/i,
];

/** Parse supplier image filenames into SKU + slot (1–4). */
export function parseLoaderFilename(filename) {
  const raw = String(filename || '').trim();
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  let working = stem.trim();

  if (!working) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'empty_filename' };
  }

  if (dot > 0 && !IMAGE_EXT.test(raw.slice(dot))) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'unsupported_extension' };
  }

  // Capture + strip the OS "(2)" duplicate marker FIRST, before the slot
  // suffix — otherwise "CODE-2 (2).jpg" would lose its slot and corrupt the code.
  // The marker counts with OR without a leading space: "CODE (2)" and "CODE(2)"
  // both mean a duplicate/variant of CODE.
  let copyIndex = 1;
  const dupMatch = working.match(/\s*\((\d+)\)$/);
  if (dupMatch) {
    copyIndex = Math.max(1, Number.parseInt(dupMatch[1], 10) || 1);
    working = working.replace(/\s*\(\d+\)$/, '').trim();
  }

  // The full code KEEPS the slot suffix (only the copy marker + noise are
  // stripped). A real variant SKU that literally ends in .2/.3/.4 can then be
  // matched exactly by the resolver before the slot suffix is interpreted.
  let fullWorking = working;
  for (const pattern of NOISE_PATTERNS) {
    fullWorking = fullWorking.replace(pattern, '').trim();
  }
  const fullCode = fullWorking.toUpperCase();

  let imageSlot = 1;
  const slotMatch = working.match(SLOT_SUFFIX);
  if (slotMatch?.groups?.sku) {
    working = String(slotMatch.groups.sku || '').trim();
    imageSlot = Math.min(4, Math.max(1, Number.parseInt(slotMatch.groups.slot || '1', 10) || 1));
  }

  for (const pattern of NOISE_PATTERNS) {
    working = working.replace(pattern, '').trim();
  }

  if (!working) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'no_sku_after_cleanup' };
  }

  const displayCode = working;
  const code = working.toUpperCase();

  if (code.length < 2) {
    return { code: '', displayCode: '', imageSlot: 1, parseError: 'sku_too_short' };
  }

  // Messy supplier names like "87747748383-10mm" or "87747748383&87747748384"
  // resolve on the first code before any separator; candidates keep the full
  // stem first so clean codes still win.
  return {
    code,
    fullCode,
    displayCode,
    imageSlot,
    copyIndex,
    parseError: null,
    codeCandidates: codeLookupCandidates(working),
    primaryCode: firstCodeToken(working),
  };
}

/** Sibling SKU a duplicate copy publishes to: CODE, CODE-2, CODE-3… */
export function siblingSkuForCopy(baseSku, copyIndex) {
  const sku = String(baseSku || '').trim().toUpperCase();
  const n = Math.max(1, Number(copyIndex) || 1);
  return n <= 1 ? sku : `${sku}-${n}`;
}

export function isSupportedImageFilename(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXT.test(raw.slice(dot));
}
