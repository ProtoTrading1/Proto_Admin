import { requireAdminKey } from './_admin-auth.js';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

const FILE = 'popup-special.json';
const DEFAULTS = { active: false, imageUrl: '', title: '' };

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const data = await readSiteConfigJson(FILE, DEFAULTS);
      return res.status(200).json({ ...DEFAULTS, ...data });
    } catch {
      return res.status(200).json(DEFAULTS);
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const saved = await writeSiteConfigJson(FILE, {
        active: Boolean(body.active),
        imageUrl: String(body.imageUrl || '').trim(),
        title: String(body.title || '').trim(),
        updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, ...saved });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
