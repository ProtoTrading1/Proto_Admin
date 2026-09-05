import { hasAdminKey, verifyAdminUser } from './_admin-auth.js';

/** Session probe for the admin SPA after Supabase login. */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // Verify the JWT once. The old requireAdminKey + verifyAdminUser sequence
  // made two identical Supabase calls on every dashboard boot.
  const keyAuthorized = hasAdminKey(req);
  const user = keyAuthorized ? null : await verifyAdminUser(req);
  if (!keyAuthorized && !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  return res.status(200).json({
    ok: true,
    email: user?.email || null,
  });
}
