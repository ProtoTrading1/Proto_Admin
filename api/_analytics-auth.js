import { createClient } from '@supabase/supabase-js';

// Same verified-email boundary as the existing admin portal. Never accept
// browser roles or user-editable metadata as authorization.
export const CURRENT_ADMIN_EMAILS = new Set([
  'danieljoffeinfo@gmail.com', 'george@proto.co.za', 'online@proto.co.za',
]);
export function createAnalyticsAdminGuard({ clientFactory = createClient, environment = process.env } = {}) {
return async function requireAnalyticsAdmin(req, res) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sign in to the admin portal to view customer analytics.' });
    return null;
  }
  try {
    const client = clientFactory(environment.VITE_SUPABASE_URL, environment.VITE_SUPABASE_ANON_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await client.auth.getUser(header.slice(7));
    if (error || !data.user) {
      res.status(401).json({ error: 'Your admin session has expired.' });
      return null;
    }
    if (!CURRENT_ADMIN_EMAILS.has(String(data.user.email || '').trim().toLowerCase())) {
      res.status(403).json({ error: 'Admin access required.' });
      return null;
    }
    return data.user;
  } catch {
    res.status(503).json({ error: 'Account verification is temporarily unavailable.' });
    return null;
  }
};
}
export const requireAnalyticsAdmin = createAnalyticsAdminGuard();
