const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const SLOT_SUFFIX = /^(?<stem>.+)\.(?<slot>[2-4])$/i;

/**
 * Controlled colour vocabulary for Product Loader filenames.
 *
 * A controlled list is intentional: it prevents a real Positill code such as
 * MP198-1 from being mistaken for a colour variant merely because it contains
 * a dash. New abbreviations can be added here without changing stored data.
 */
export const COLOUR_VARIANT_LABELS = Object.freeze({
  BEI: 'Beige',
  BLK: 'Black',
  BLU: 'Blue',
  BRN: 'Brown',
  CAM: 'Camel',
  CRM: 'Cream',
  DPNK: 'Dark Pink',
  DRED: 'Dark Red',
  GLD: 'Gold',
  GRN: 'Green',
  GRY: 'Grey',
  KHA: 'Khaki',
  LBL: 'Light Blue',
  LGR: 'Light Green',
  LPNK: 'Light Pink',
  LPUR: 'Light Purple',
  LRED: 'Light Red',
  MAR: 'Maroon',
  MUL: 'Multi-colour',
  NAV: 'Navy',
  ORG: 'Orange',
  PNK: 'Pink',
  PUR: 'Purple',
  RED: 'Red',
  SIL: 'Silver',
  TAN: 'Tan',
  WHT: 'White',
  YEL: 'Yellow',
});

function normaliseStem(rawStem) {
  return String(rawStem || '')
    .trim()
    .replace(/\s*-\s*/g, '-')
    .replace(/[_\s]+(front|back|side|detail|hero)$/i, '')
    .trim();
}

/**
 * Parse a recognised colour suffix without changing normal filename parsing.
 *
 * Examples:
 *  - 8621000002-WHT.jpg   -> base 8621000002, variant WHT, preferred slot 1
 *  - 8621000002-CRM.2.jpg -> base 8621000002, variant CRM, preferred slot 2
 *  - MP198-1.jpg          -> null (1 is not a recognised colour)
 */
export function parseColourVariantFilename(filename) {
  const raw = String(filename || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || !IMAGE_EXT.test(raw.slice(dot))) return null;

  let stem = raw.slice(0, dot).trim();
  let copyIndex = 1;
  const copyMatch = stem.match(/\s*\((\d+)\)$/);
  if (copyMatch) {
    copyIndex = Math.max(1, Number.parseInt(copyMatch[1], 10) || 1);
    stem = stem.replace(/\s*\(\d+\)$/, '').trim();
  }

  let preferredSlot = null;
  const slotMatch = stem.match(SLOT_SUFFIX);
  if (slotMatch?.groups?.stem) {
    stem = slotMatch.groups.stem;
    preferredSlot = Math.min(4, Math.max(1, Number(slotMatch.groups.slot) || 1));
  }

  const cleanStem = normaliseStem(stem);
  // The colour is always the final controlled suffix. Using the last dash
  // preserves legitimate Positill codes that contain a dash themselves
  // (for example MP198-1-WHT -> base MP198-1, colour WHT).
  const dashIndex = cleanStem.lastIndexOf('-');
  if (dashIndex <= 0 || dashIndex === cleanStem.length - 1) return null;

  const positillCode = cleanStem.slice(0, dashIndex).trim().toUpperCase();
  const suffix = cleanStem.slice(dashIndex + 1).trim().toUpperCase();
  const variantCode = suffix.split(/[._\s-]+/)[0];
  const variantLabel = COLOUR_VARIANT_LABELS[variantCode];
  if (!positillCode || !variantLabel) return null;

  return {
    positillCode,
    variantCode,
    variantLabel,
    variantSku: `${positillCode}-${variantCode}`,
    preferredSlot,
    copyIndex,
  };
}

/**
 * Allocate each colour variant's selected files to unique image slots 1–4.
 * Explicit .2/.3/.4 positions are respected where possible; otherwise files
 * fill the first open slot in natural filename order.
 */
export function assignColourVariantImageSlots(rows = []) {
  const result = rows.map((row) => ({ ...row }));
  const groups = new Map();

  result.forEach((row, index) => {
    if (!row?.colourVariant?.variantSku) return;
    const key = row.colourVariant.variantSku;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, index });
  });

  for (const entries of groups.values()) {
    entries.sort((a, b) => {
      const aPreferred = a.row.colourVariant.preferredSlot ?? Number.MAX_SAFE_INTEGER;
      const bPreferred = b.row.colourVariant.preferredSlot ?? Number.MAX_SAFE_INTEGER;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      const aCopy = a.row.colourVariant.copyIndex || 1;
      const bCopy = b.row.colourVariant.copyIndex || 1;
      if (aCopy !== bCopy) return aCopy - bCopy;
      return String(a.row.filename || '').localeCompare(String(b.row.filename || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

    const used = new Set();
    for (const entry of entries) {
      const preferred = entry.row.colourVariant.preferredSlot;
      let slot = preferred && !used.has(preferred) ? preferred : null;
      if (!slot) slot = [1, 2, 3, 4].find((candidate) => !used.has(candidate)) || null;
      if (slot) used.add(slot);
      result[entry.index] = {
        ...entry.row,
        assignedImageSlot: slot,
        tooManyVariantImages: !slot,
      };
    }
  }

  return result;
}
