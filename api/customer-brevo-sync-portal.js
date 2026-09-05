import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { fetchCustomerAudience } from './_brevo-email.js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function brevoFetch(path, { method = 'GET', body } = {}) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY not configured');
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method,
    headers: { 'api-key': key, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Brevo ${res.status}`);
  return json;
}

/** Push all portal customer emails (approved + proto active) into Brevo contacts. */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const sb = getAdminClient();
    const recipients = await fetchCustomerAudience(sb, 'all-portal');
    if (!recipients.length) {
      return res.status(400).json({ error: 'No portal customer emails to push.' });
    }

    const listPayload = {
      emails: recipients.map((r) => ({
        email: r.email,
        attributes: { FIRSTNAME: r.name?.split(' ')[0] || '', LASTNAME: r.name?.split(' ').slice(1).join(' ') || '' },
      })),
      updateExistingContacts: true,
      emptyContactsAttributes: false,
    };

    const result = await brevoFetch('/contacts/import', {
      method: 'POST',
      body: {
        jsonBody: listPayload,
        listIds: [],
        notifyUrl: null,
      },
    });

    return res.status(200).json({
      ok: true,
      pushed: recipients.length,
      processId: result.processId || null,
    });
  } catch (err) {
    console.error('customer-brevo-sync-portal:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Push to Brevo failed' });
  }
}
