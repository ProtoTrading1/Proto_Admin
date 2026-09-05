/**
 * Phone normalization for team-member contact numbers.
 * (Extracted from the removed WATI module — this is plain data hygiene, no
 * messaging automation.)
 */
export function normalizePhone(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `27${digits.slice(1)}`;
  return digits;
}
