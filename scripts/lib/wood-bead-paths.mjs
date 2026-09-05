/** Name-based wood bead category inference. */

export function inferWoodBeadPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (/PAINTED/.test(n)) return 'Beads > Wood > Painted';
  if (/COCO/.test(n)) return 'Beads > Wood > Coco Wood';
  if (/WASHED\s*WOOD/.test(n)) return 'Beads > Wood > Washed Wood';
  if (/\bRAW\b/.test(n) && /\bWOOD/.test(n)) return 'Beads > Wood > Raw Wood';
  return 'Beads > Wood';
}

export function isWoodBeadName(productName) {
  const n = String(productName || '').toUpperCase();
  return /WOODEN?\s*BEAD|WOOD\s*BEAD|PAINTED\s*WOOD|WOODEN\s*BEADS|WOOD\s*PAINTED|WASHED\s*WOOD/.test(n)
    || (/\bWOOD/.test(n) && /\bBEAD|ROUND-\d+mm/.test(n));
}
