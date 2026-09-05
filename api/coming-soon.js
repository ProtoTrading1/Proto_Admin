import { requireAdminKey } from './_admin-auth.js';
import { readSiteConfigJson } from './_site-config.js';
import { mutateSiteConfigJson } from './_site-config-mutate.js';

const COMING_SOON_FILE = 'site-config/coming-soon.json';

const DEFAULT = { categoryIds: [], skus: [], updatedAt: null };

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const data = await readSiteConfigJson(COMING_SOON_FILE, DEFAULT);
      return res.status(200).json({
        categoryIds: Array.isArray(data.categoryIds) ? data.categoryIds : [],
        skus: Array.isArray(data.skus) ? data.skus : [],
        updatedAt: data.updatedAt || null,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to load coming soon config' });
    }
  }

  if (req.method === 'POST') {
    const categoryIds = [...new Set(
      (Array.isArray(req.body?.categoryIds) ? req.body.categoryIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    )];
    const skus = [...new Set(
      (Array.isArray(req.body?.skus) ? req.body.skus : [])
        .map((s) => String(s || '').trim())
        .filter(Boolean),
    )];

    const baseUpdatedAt = req.body?.baseUpdatedAt ? String(req.body.baseUpdatedAt) : null;

    try {
      let conflict = null;
      // Compare-and-set through the shared mutator so two admins saving at
      // once serialize instead of silently clobbering each other's config.
      const saved = await mutateSiteConfigJson(COMING_SOON_FILE, DEFAULT, (store) => {
        if (baseUpdatedAt && (store?.updatedAt || null) !== baseUpdatedAt) {
          conflict = { currentUpdatedAt: store?.updatedAt || null };
          return { abort: true };
        }
        return { categoryIds, skus };
      });
      if (conflict) {
        return res.status(409).json({
          error: 'This content was changed by someone else since you loaded it. Refresh and re-apply your edit.',
          currentUpdatedAt: conflict.currentUpdatedAt,
        });
      }
      return res.status(200).json({
        ok: true,
        categoryIds: saved.categoryIds || categoryIds,
        skus: saved.skus || skus,
        updatedAt: saved.updatedAt,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to save coming soon config' });
    }
  }

  return res.status(405).end();
}
