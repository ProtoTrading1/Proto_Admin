/** Route art/craft products out of Stationery into Arts and Crafts taxonomy. */

const BASE = 'Arts and Crafts > Art Supplies';

export function isArtSupplyProduct(productName) {
  const n = String(productName || '').toUpperCase();
  return /EASEL|PAINTBRUSH|PAINT BRUSH|CANVAS|SPRAY PAINT|ACRYLIC PAINT|TEMPERA|OIL COLOUR|OIL COLOR|CRAFT PAINT|PAINTING APRON|PAINTING PALETTE|PALETTE KNIFE|PAINTING SPATULA|BRUSH WASH|BRUSH CLEANER|PAINTING MASK|STRETCH CANVAS|PANEL CANVAS|BOX CANVAS|CANVAS BOX|CANVAS PANEL|CANVAS STRETCH|CANVAS AND TRIPOD|RETRACTABLE BRUSH/i.test(n);
}

export function inferArtSupplyPath(productName) {
  const n = String(productName || '').toUpperCase();
  if (!isArtSupplyProduct(n)) return null;

  if (/\bEASEL\b/.test(n)) return `${BASE} > Easels`;

  if (/PAINTBRUSH|PAINT BRUSH|BRUSH WASH|BRUSH CLEANER|RETRACTABLE BRUSH/i.test(n)) {
    return `${BASE} > Brushes & Applicators`;
  }

  if (/SPRAY PAINT/i.test(n)) return `${BASE} > Paints > Acrylic`;

  if (/ACRYLIC PAINT|CRAFT PAINT/i.test(n)) return `${BASE} > Paints > Acrylic`;

  if (/TEMPERA/i.test(n)) return `${BASE} > Paints > Tempera`;

  if (/OIL COLOUR|OIL COLOR/i.test(n)) return `${BASE} > Paints > Oil`;

  if (/PAINTING APRON/i.test(n)) return `${BASE} > Aprons`;

  if (/BOX CANVAS|CANVAS BOX/i.test(n)) return `${BASE} > Canvas > Box`;

  if (/PANEL CANVAS|CANVAS PANEL/i.test(n)) return `${BASE} > Canvas > Panel`;

  if (/STRETCH CANVAS|CANVAS STRETCH|CANVAS AND TRIPOD/i.test(n)) {
    return `${BASE} > Canvas > Stretch`;
  }

  if (/PAINTING PALETTE|PALETTE KNIFE|PAINTING SPATULA|PAINTING MASK/i.test(n)) {
    return `${BASE} > Painting Tools & Accessories`;
  }

  if (/\bCANVAS\b/.test(n)) return `${BASE} > Canvas > Stretch`;

  return `${BASE} > Painting Tools & Accessories`;
}
