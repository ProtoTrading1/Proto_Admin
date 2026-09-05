/** Route stationery products into Writing & Correction subcategories by title. */

const BASE = 'Stationery > School & Office > Writing & Correction';

export function isWritingCorrectionExcluded(productName) {
  const n = String(productName || '').toUpperCase();
  return /PENCIL\s*CASE|PENCIL\s*BAG|PEN\s*BAG|SHARPENER|TAPE\s*DISP|BANKNOTE\s*TESTER|LETTER\s*OPENER/i.test(n)
    || /DIARY|PLANNER|NOTEBOOK|MEMO\s*BOOK|EXERCISE\s*BOOK|SKETCH\s*PAD|STUDY\s*BOOK/i.test(n);
}

export function isWritingCorrectionProduct(productName) {
  const n = String(productName || '').toUpperCase();
  if (isWritingCorrectionExcluded(n)) return false;
  return /\bPEN\b|\bPENCIL\b|MARKER|HIGHLIGHTER|\bERASER\b|CORRECTION|CRAYON|\bCHALK\b|FINELINER|BALLPOINT|FIBRE\s*TIP|FIBER\s*TIP|ROLLERBALL|ROLLER\s*BALL/i.test(n);
}

export function inferWritingCorrectionPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (!isWritingCorrectionProduct(n)) return null;

  if (/LIQUID\s*CHALK|CHALK\s*MARKER/i.test(n)) {
    return `${BASE} > Markers and Highlighters`;
  }

  if (/MARKER|HIGHLIGHTER|WHITEBOARD/i.test(n)) {
    return `${BASE} > Markers and Highlighters`;
  }

  if (/ERASER|CORRECTION\s*TAPE|CORRECTING/i.test(n)) {
    return `${BASE} > Correction and Erasing`;
  }

  if (/COLOUR\s*PENCIL|COLOR\s*PENCIL|CRAYON|PENCIL\s*CRAYON|WAX\s*JUMBO|CHARCOAL\s*PENCIL|WOODLESS\s*CHARCOAL|\bCHALK\b/i.test(n)) {
    return `${BASE} > Colour Pencils and Crayons`;
  }

  if (/\bPEN\b|\bPENCIL\b|BALLPOINT|GEL\s*PEN|FINELINER|FIBRE\s*TIP|FIBER\s*TIP|ROLLERBALL|ROLLER\s*BALL/i.test(n)) {
    return `${BASE} > Pens and Pencils`;
  }

  return null;
}
