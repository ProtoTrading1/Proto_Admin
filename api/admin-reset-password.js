import {
  findAdminAuthUser,
  getAdminAuthClient,
  getResetSecret,
  getResetTokenVersion,
  revokeUserSessions,
  verifyResetToken,
} from './_admin-password-reset.js';
import { checkRateLimit, clientIp } from './_rate-limit.js';

/** Complete admin password reset from emailed token link. */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const secret = getResetSecret();
  if (!secret) return res.status(500).json({ error: 'Server misconfigured' });

  // Throttle brute-forcing of the token endpoint (per IP, fixed 1h window).
  const ip = clientIp(req);
  const ipLimit = await checkRateLimit({ bucket: `admin-reset:ip:${ip}`, max: 20, windowSeconds: 3600 });
  if (!ipLimit.allowed) {
    if (ipLimit.retryAfter) res.setHeader('Retry-After', String(ipLimit.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  }

  let claim;
  try {
    claim = verifyResetToken(token, secret); // { email, v }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const supabase = getAdminAuthClient();
    const user = await findAdminAuthUser(supabase, claim.email);
    if (!user) return res.status(400).json({ error: 'This reset link is no longer valid.' });

    // Single-use: the link carries the token version at issue time. A completed
    // reset (or a newer link) bumps it, so a replayed or superseded link fails.
    if (getResetTokenVersion(user) !== claim.v) {
      return res.status(400).json({ error: 'This reset link has already been used or replaced. Request a new one.' });
    }

    // Atomic single-use: rotate the password AND bump reset_token_version in
    // the SAME write, so a partial failure can never leave the link replayable
    // for the rest of its TTL (a separate bump could fail after the password
    // already changed).
    const nextVersion = getResetTokenVersion(user) + 1;
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
      app_metadata: { ...(user.app_metadata || {}), reset_token_version: nextVersion },
    });
    if (error) return res.status(400).json({ error: error.message });

    // Then log out every existing session.
    await revokeUserSessions(supabase, user.id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin-reset-password:', err.message);
    return res.status(500).json({ error: 'Password reset failed' });
  }
}
