import { isAdminEmail } from './_admin-auth.js';
import { PROTO_URLS } from './_proto-urls.js';
import {
  findAdminAuthUser,
  getAdminAuthClient,
  getResetSecret,
  getResetTokenVersion,
  makeResetToken,
  sendAdminResetEmail,
} from './_admin-password-reset.js';
import { checkRateLimit, clientIp } from './_rate-limit.js';

// Identical response for every input — no account-existence oracle.
const GENERIC_OK = {
  ok: true,
  message: 'If that email has admin access, a reset link is on its way.',
};

/** Send admin password reset via Brevo (Supabase built-in email is not used). */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const email = String(req.body?.email || '').trim().toLowerCase();

  const secret = getResetSecret();
  if (!secret) return res.status(500).json({ error: 'Server misconfigured' });

  // Rate limit per IP and per email (fixed 1h window). Generic 429 either way.
  const ip = clientIp(req);
  const ipLimit = await checkRateLimit({ bucket: `admin-forgot:ip:${ip}`, max: 10, windowSeconds: 3600 });
  const emailLimit = email
    ? await checkRateLimit({ bucket: `admin-forgot:email:${email}`, max: 5, windowSeconds: 3600 })
    : { allowed: true };
  if (!ipLimit.allowed || !emailLimit.allowed) {
    const retryAfter = Math.max(ipLimit.retryAfter || 0, emailLimit.retryAfter || 0);
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many reset requests. Please wait and try again.' });
  }

  // Only allowlisted admin emails with an EXISTING auth account receive mail.
  // We never auto-create accounts from this unauthenticated endpoint, and we
  // always return the same generic 200 so this cannot be used to probe which
  // addresses exist.
  try {
    if (email && isAdminEmail(email)) {
      const supabase = getAdminAuthClient();
      const user = await findAdminAuthUser(supabase, email);
      if (user) {
        const token = makeResetToken(email, secret, getResetTokenVersion(user));
        const resetLink = `${PROTO_URLS.admin}/reset-password?token=${encodeURIComponent(token)}`;
        await sendAdminResetEmail(email, resetLink);
      }
    }
  } catch (err) {
    // Log server-side but still return generic success — an internal error must
    // not become a side-channel that distinguishes known from unknown emails.
    console.error('admin-forgot-password:', err.message);
  }

  return res.status(200).json(GENERIC_OK);
}
