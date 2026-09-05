import { requireAdminKey } from './_admin-auth.js';
import {
  downloadNutstoreFile,
  isNutstoreConfigured,
  isPathInLibrary,
  normalizeDavPath,
  nutstoreSetupMessage,
} from './_nutstore-webdav.js';

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!isNutstoreConfigured()) {
    return res.status(503).json({ error: nutstoreSetupMessage() });
  }

  if (req.method !== 'GET') return res.status(405).end();

  const path = normalizeDavPath(req.query.path || '');
  if (!path || path === '/' || !isPathInLibrary(path)) {
    return res.status(400).json({ error: 'path query required (within PTR Photos)' });
  }

  try {
    const { buffer, contentType } = await downloadNutstoreFile(path);
    const maxPreview = 8 * 1024 * 1024;
    if (buffer.length > maxPreview) {
      return res.status(413).json({ error: 'File too large for preview' });
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Thumbnail failed' });
  }
}
