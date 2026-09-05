import { requireAdminKey, requireOwner } from './_admin-auth.js';
import {
  FEATURE_DEFAULTS,
  FEATURE_FILE,
  invalidateFeatureFlags,
  normalizeFeatureFlags,
  readFeatureFlags,
} from './_feature-flags.js';
import { mutateSiteConfigJson } from './_site-config-mutate.js';

/**
 * Runtime feature flags for the admin UI.
 *
 * GET  → { flags } (any admin) so the UI can show/hide gated affordances.
 * POST { key, value } → toggle one flag (owner only). Writes features/flags.json
 *   through the compare-and-set mutator; only known flags are accepted and only
 *   a literal boolean is stored.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!(await requireAdminKey(req, res))) return;
    const flags = await readFeatureFlags({ force: true });
    return res.status(200).json({ flags });
  }

  if (req.method === 'POST') {
    if (!(await requireOwner(req, res))) return;
    const key = String(req.body?.key || '').trim();
    if (!Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, key)) {
      return res.status(400).json({ error: `Unknown feature flag: ${key}` });
    }
    const value = req.body?.value === true;
    try {
      const saved = await mutateSiteConfigJson(FEATURE_FILE, {}, (store) => {
        const next = normalizeFeatureFlags(store);
        next[key] = value;
        return next;
      });
      invalidateFeatureFlags();
      return res.status(200).json({ ok: true, flags: normalizeFeatureFlags(saved) });
    } catch (err) {
      console.error('feature-flags POST:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to update flag' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end();
}
