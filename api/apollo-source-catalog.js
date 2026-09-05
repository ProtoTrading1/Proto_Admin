import { getAdminRole, requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { filterApolloSourcesForRole } from '../lib/apollo-source-catalog.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdminKey(req, res))) return;
  const admin = await verifyAdminUser(req);
  const role = getAdminRole(admin?.email) || 'owner';
  const sources = filterApolloSourcesForRole(role);
  return res.status(200).json({
    mode: 'read_only',
    role,
    connected: sources.filter((item) => item.status === 'connected').length,
    planned: sources.filter((item) => item.status === 'planned').length,
    sources,
  });
}
