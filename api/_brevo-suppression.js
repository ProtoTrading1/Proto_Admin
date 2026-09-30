const BREVO_PAGE_SIZE = 1000;
const MAX_BREVO_CONTACTS = 50_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function brevoHeaders() {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not configured');
  return { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey };
}

async function createBrevoSuppressedContact(email) {
  const response = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: brevoHeaders(),
    body: JSON.stringify({ email, emailBlacklisted: true, updateEnabled: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Brevo ${response.status}`);
}

export async function suppressBrevoContact(email, { createIfMissing = true } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  const response = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(normalized)}`, {
    method: 'PUT',
    headers: brevoHeaders(),
    body: JSON.stringify({ emailBlacklisted: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404 && createIfMissing) {
    await createBrevoSuppressedContact(normalized);
    return;
  }
  if (!response.ok && response.status !== 404) throw new Error(body.message || `Brevo ${response.status}`);
}

async function fetchBrevoPage(offset) {
  const params = new URLSearchParams({ limit: String(BREVO_PAGE_SIZE), offset: String(offset), sort: 'desc' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`https://api.brevo.com/v3/contacts?${params}`, {
      headers: brevoHeaders(), signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 2) {
      const retryAfter = response.headers?.get('retry-after');
      const seconds = Number(retryAfter);
      const dateDelay = Date.parse(retryAfter || '') - Date.now();
      const delay = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
      // Do not hammer Brevo or wait beyond the serverless request budget.
      if (delay > 10_000) throw new Error('Brevo is rate-limiting the suppression check. Try again later; no broadcast has been sent.');
      await pause(Math.max(1000 * (attempt + 1), Number.isFinite(delay) ? delay : 0));
      continue;
    }
    if (!response.ok) throw new Error(body.message || `Brevo ${response.status}`);
    if (!Array.isArray(body.contacts) || !Number.isSafeInteger(body.count) || body.count < 0) {
      throw new Error('Brevo returned an incomplete suppression response');
    }
    return { contacts: body.contacts, count: body.count };
  }
}

export async function listBrevoSuppressedContacts() {
  const first = await fetchBrevoPage(0);
  const contacts = [...first.contacts];
  if (first.count > MAX_BREVO_CONTACTS) {
    throw new Error('The Brevo contact list exceeds the complete suppression-check limit. No broadcast has been sent.');
  }
  for (let offset = BREVO_PAGE_SIZE; offset < first.count; offset += BREVO_PAGE_SIZE) {
    await pause(120);
    const page = await fetchBrevoPage(offset);
    if (page.count !== first.count) throw new Error('Brevo contacts changed during the suppression check. Reload before sending.');
    contacts.push(...page.contacts);
  }
  if (contacts.length !== first.count) throw new Error('Brevo suppression check is incomplete. No broadcast has been sent.');
  return contacts.filter((contact) => contact.emailBlacklisted === true).map((contact) => {
    const attrs = contact.attributes || {};
    return {
      email: String(contact.email || '').trim().toLowerCase(),
      business_name: attrs.COMPANY || attrs.COMPANY_NAME || attrs.BUSINESS_NAME || attrs.ORGANIZATION || '',
      contact_name: [attrs.FIRSTNAME || attrs.FIRST_NAME, attrs.LASTNAME || attrs.LAST_NAME].filter(Boolean).join(' ').trim(),
      source: 'brevo',
      unsubscribed_at: contact.modifiedAt || null,
      created_at: contact.createdAt || null,
    };
  }).filter((row) => row.email);
}

// Always read fresh Brevo suppression state before a real send. Never trust
// a browser snapshot or reuse a stale list when Brevo cannot be checked.
export async function excludeBrevoSuppressedRecipients(recipients) {
  if (!recipients.length) return recipients;
  const blocked = new Set((await listBrevoSuppressedContacts()).map((row) => row.email));
  return recipients.filter((row) => !blocked.has(String(row.email || '').trim().toLowerCase()));
}
