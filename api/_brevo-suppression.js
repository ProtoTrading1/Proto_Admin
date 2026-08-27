const BREVO_PAGE_SIZE = 1000;
const MAX_BREVO_CONTACTS = 50_000;
const BREVO_FETCH_CONCURRENCY = 4;

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
  const response = await fetch(`https://api.brevo.com/v3/contacts?${params}`, { headers: brevoHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Brevo ${response.status}`);
  return { contacts: body.contacts || [], count: Number(body.count) || 0 };
}

export async function listBrevoSuppressedContacts() {
  const first = await fetchBrevoPage(0);
  const contacts = [...first.contacts];
  const upperBound = Math.min(MAX_BREVO_CONTACTS, first.count || first.contacts.length);
  const offsets = [];
  for (let offset = BREVO_PAGE_SIZE; offset < upperBound; offset += BREVO_PAGE_SIZE) offsets.push(offset);
  for (let index = 0; index < offsets.length; index += BREVO_FETCH_CONCURRENCY) {
    const pages = await Promise.all(offsets.slice(index, index + BREVO_FETCH_CONCURRENCY).map(fetchBrevoPage));
    pages.forEach((page) => contacts.push(...page.contacts));
  }
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
