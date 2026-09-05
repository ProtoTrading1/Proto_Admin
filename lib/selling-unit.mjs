export const SELLING_UNIT_SUGGESTIONS = Object.freeze([
  'EACH',
  'PAIR',
  'SET',
  'PACK 5',
  'PACK 10',
  'PACK 20',
  'PACK 50',
  'DOZEN',
  'BAG',
  'BOX',
  'ROLL',
  'METRE',
]);

/** Store one predictable value while still allowing uncommon wholesale units. */
export function normalizeUnitsOfIssue(value, fallback = 'EACH') {
  let raw = String(value ?? '').trim().toUpperCase();
  if (!raw) raw = String(fallback ?? '').trim().toUpperCase();
  if (!raw) return 'EACH';

  raw = raw
    .replace(/[×*]/g, ' X ')
    .replace(/[,;]+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^(?:EA|EACH|SINGLE|1)$/.test(raw)) return 'EACH';
  if (/^(?:PR|PAIR)$/.test(raw)) return 'PAIR';
  if (/^(?:DZ|DOZ|DOZEN|12)$/.test(raw)) return 'DOZEN';
  if (/^(?:M|METER|METERS|METRE|METRES)$/.test(raw)) return 'METRE';

  const counted = raw.match(/^(PACK|PK|PKT|PACKET|BAG|BOX|SET|CARD)\s*(?:OF|X)?\s*(\d{1,5})$/);
  if (counted) {
    const type = ['PK', 'PKT', 'PACKET'].includes(counted[1]) ? 'PACK' : counted[1];
    return `${type} ${Number(counted[2])}`;
  }

  return raw.slice(0, 40);
}

export function sellingUnitLabel(value) {
  const unit = normalizeUnitsOfIssue(value);
  const counted = unit.match(/^(PACK|BAG|BOX|SET|CARD) (\d+)$/);
  if (counted) {
    const noun = counted[1][0] + counted[1].slice(1).toLowerCase();
    return `${noun} of ${counted[2]}`;
  }
  return unit[0] + unit.slice(1).toLowerCase();
}
