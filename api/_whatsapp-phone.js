/**
 * Phone normalization for the WhatsApp CRM.
 *
 * `_phone.js` handles team numbers, which admins type carefully. Customer
 * numbers are self-entered at signup and are genuinely messy — the live table
 * holds `0821234567`, `27821234567`, `270821234567`, `821234567`,
 * `0027821234567` and Cape Town landlines, all under accept_whatsapp = true.
 * Sending to a mangled number burns a WhatsApp template credit and returns a
 * useless "not a valid number", so every number is classified here first and
 * the bad ones are surfaced in the UI instead of being silently dropped.
 *
 * Output is bare international digits (no `+`), which is what WATI wants.
 */

const SA_MOBILE_PREFIXES = /^(6|7|8)/;

/**
 * @returns {{phone: string, valid: boolean, kind: string|null, reason: string|null}}
 *   `kind` is 'sa_mobile' | 'sa_landline' | 'international'.
 */
export function normalizeWhatsappPhone(input) {
  const raw = String(input ?? '');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return { phone: '', valid: false, kind: null, reason: 'No phone number' };

  // The live table holds fields like "0839495561   0629228360" and
  // "+264818792088/811249648" — two numbers in one column. Stripping the
  // punctuation would glue them into one long bogus number, so say what is
  // actually wrong: an admin can fix a "two numbers" flag, not a length error.
  const groups = raw.split(/[,;/&]|\s{2,}|\bor\b/i)
    .map((part) => part.replace(/\D/g, ''))
    .filter((part) => part.length >= 8);
  if (groups.length > 1) {
    return { phone: '', valid: false, kind: null, reason: 'More than one number in this field' };
  }

  // International dial-out prefix typed instead of "+".
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    // Local format: 0821234567 → 27821234567.
    digits = `27${digits.slice(1)}`;
  } else if (digits.startsWith('27') && digits.length === 12 && digits[2] === '0') {
    // Country code pasted in front of the local format: 270821234567.
    digits = `27${digits.slice(3)}`;
  } else if (digits.length === 9 && SA_MOBILE_PREFIXES.test(digits)) {
    // Leading zero lost, e.g. a spreadsheet that stored the number as an
    // integer: 821234567 → 27821234567.
    digits = `27${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) {
    return { phone: digits, valid: false, kind: null, reason: 'Number is the wrong length' };
  }

  if (digits.startsWith('27')) {
    const local = digits.slice(2);
    if (local.length !== 9) {
      return { phone: digits, valid: false, kind: null, reason: 'Not a valid South African number' };
    }
    if (SA_MOBILE_PREFIXES.test(local)) {
      return { phone: digits, valid: true, kind: 'sa_mobile', reason: null };
    }
    // A landline is a well-formed number that almost never has WhatsApp. Keep
    // it eligible-but-flagged: the admin can see why it will probably fail
    // rather than wondering where the contact went.
    return { phone: digits, valid: true, kind: 'sa_landline', reason: 'Looks like a landline' };
  }

  return { phone: digits, valid: true, kind: 'international', reason: null };
}

/** Display form for the admin UI: +27 82 123 4567 / +264 81 234 5678. */
export function formatWhatsappPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.startsWith('27') && digits.length === 11) {
    return `+27 ${digits.slice(2, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}
