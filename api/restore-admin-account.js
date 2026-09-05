import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { isAdminEmail } from './_admin-auth.js';
import { PROTO_URLS } from './_proto-urls.js';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function hasCronSecret(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const provided = String(
    req.headers['x-cron-secret']
    || req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || '',
  ).trim();
  if (!provided) return false;
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function findUserByEmail(supabase, email) {
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = (data?.users || []).find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (!data?.users?.length || data.users.length < 200) break;
    page += 1;
  }
  return null;
}

/**
 * Restore or reset an allowlisted admin Supabase auth account.
 * Secured by CRON_SECRET only — use when an admin deleted their login.
 *
 * POST { email, password? }
 * - If user missing: password required (min 8 chars) to create account
 * - If user exists: optional password to set directly; otherwise sends reset email
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  if (!hasCronSecret(req)) {
    return res.status(401).json({ error: 'CRON_SECRET required' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!isAdminEmail(email)) {
    return res.status(403).json({ error: 'Email is not on the admin allowlist' });
  }

  const supabase = getAdminClient();
  const existing = await findUserByEmail(supabase, email);

  if (existing) {
    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const { error } = await supabase.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
      });
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true, action: 'password-updated', email, userId: existing.id });
    }

    const redirectTo = `${PROTO_URLS.admin}/`;
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({
      ok: true,
      action: 'recovery-link',
      email,
      userId: existing.id,
      recoveryLink: data?.properties?.action_link || null,
    });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({
      error: 'No auth user found for this email. Provide password (min 8 chars) to create the account.',
    });
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: email.split('@')[0] },
  });

  if (createError) {
    return res.status(400).json({ error: createError.message || 'Failed to create admin account' });
  }

  return res.status(200).json({
    ok: true,
    action: 'created',
    email,
    userId: created?.user?.id || null,
  });
}
