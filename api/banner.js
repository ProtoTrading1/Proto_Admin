import { requireOwner } from './_admin-auth.js';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';

const FILE = 'banner.json';
const DEFAULTS = {
  title: '',
  body: '',
  imageUrl: '',
};

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
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
        title: String(body.title || DEFAULTS.title).trim(),
        body: String(body.body || DEFAULTS.body).trim(),
        imageUrl: String(body.imageUrl || DEFAULTS.imageUrl).trim(),
        // Bumped on every save so the portal busts its cached banner image.
        updatedAt: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, ...saved });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
