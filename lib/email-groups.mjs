/**
 * Email groups — pure parsing and validation for uploaded member lists.
 *
 * Group members are NOT customers. They live only in email_groups /
 * email_group_members, never in public.customers, so they cannot appear in
 * Customer Management or in any audience other than their own group.
 */

/** Columns the sample CSV ships with. Only `email` is required. */
export const GROUP_CSV_COLUMNS = ['email', 'name', 'business_name'];

/** Header spellings an admin might reasonably paste from a spreadsheet. */
const HEADER_ALIASES = {
  email: 'email',
  'email address': 'email',
  'e-mail': 'email',
  mail: 'email',
  name: 'name',
  'first name': 'name',
  'contact name': 'name',
  contact: 'name',
  'full name': 'name',
  business: 'business_name',
  'business name': 'business_name',
  company: 'business_name',
  'company name': 'business_name',
  business_name: 'business_name',
};

// Deliberately permissive: this gate exists to catch paste accidents and
// obvious junk, not to adjudicate the email RFC. Brevo is the real arbiter.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function isPlausibleEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

export function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanCell(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normaliseGroupName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

/** Maps a header row onto our three fields; unknown columns are ignored. */
export function mapHeaders(headerRow) {
  const map = {};
  (headerRow || []).forEach((raw, index) => {
    const key = HEADER_ALIASES[String(raw || '').trim().toLowerCase()];
    if (key && map[key] === undefined) map[key] = index;
  });
  return map;
}

/**
 * Turn a parsed sheet (array of cell arrays) into members ready to insert.
 *
 * A file with no recognisable header is still usable when its first column
 * looks like an email — admins paste bare address lists constantly, and
 * rejecting those would send them back to Excel for no good reason.
 */
export function parseGroupRows(rows) {
  const table = Array.isArray(rows) ? rows.filter((r) => Array.isArray(r) && r.some((c) => cleanCell(c))) : [];
  if (!table.length) {
    return { members: [], skipped: [], duplicates: 0, total: 0 };
  }

  let headers = mapHeaders(table[0]);
  let body = table.slice(1);
  if (headers.email === undefined) {
    // No header we recognise. If the first cell of the first row is an email,
    // treat the whole sheet as data with email in column 0.
    if (isPlausibleEmail(table[0][0])) {
      headers = { email: 0, name: 1, business_name: 2 };
      body = table;
    } else {
      return { members: [], skipped: [], duplicates: 0, total: 0, error: 'No email column found. The first column should be email addresses, or add an "email" header.' };
    }
  }

  const seen = new Set();
  const members = [];
  const skipped = [];
  let duplicates = 0;

  body.forEach((row, index) => {
    const email = normaliseEmail(row[headers.email]);
    if (!email) return;
    if (!isPlausibleEmail(email)) {
      skipped.push({ row: index + 2, value: cleanCell(row[headers.email], 80), reason: 'Not a valid email address' });
      return;
    }
    if (seen.has(email)) { duplicates += 1; return; }
    seen.add(email);
    members.push({
      email,
      name: headers.name === undefined ? '' : cleanCell(row[headers.name]),
      business_name: headers.business_name === undefined ? '' : cleanCell(row[headers.business_name]),
    });
  });

  return { members, skipped, duplicates, total: body.length };
}

/** The sample file an admin downloads before building their own list. */
export function sampleGroupCsv() {
  return [
    GROUP_CSV_COLUMNS.join(','),
    'jane@example.co.za,Jane Dlamini,Dlamini Stationers',
    'sam@example.co.za,Sam Naidoo,Naidoo Wholesale',
    'orders@example.co.za,,Corner Craft Shop',
  ].join('\n');
}

/** Server-side guard — never trust the client's parse. */
export function validateMemberPayload(members, { max = 50000 } = {}) {
  if (!Array.isArray(members)) return { ok: false, error: 'Members must be an array' };
  if (members.length > max) return { ok: false, error: `A group can hold at most ${max} members` };

  const seen = new Set();
  const clean = [];
  for (const member of members) {
    const email = normaliseEmail(member?.email);
    if (!isPlausibleEmail(email) || seen.has(email)) continue;
    seen.add(email);
    clean.push({
      email,
      name: cleanCell(member?.name),
      business_name: cleanCell(member?.business_name),
    });
  }
  return { ok: true, members: clean };
}
