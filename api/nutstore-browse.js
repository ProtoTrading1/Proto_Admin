import { requireOwner } from './_admin-auth.js';
import {
  clampToLibrary,
  formatNutstoreError,
  isNutstoreConfigured,
  isNutstoreRateLimitError,
  libraryRoot,
  listNutstoreDirectory,
  listNutstoreImagesRecursive,
  nutstoreSetupMessage,
  testNutstoreConnection,
} from './_nutstore-webdav.js';

function nutstoreErrorStatus(err) {
  return isNutstoreRateLimitError(err) ? 429 : 502;
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!isNutstoreConfigured()) {
    return res.status(503).json({ error: nutstoreSetupMessage(), configured: false });
  }

  const rootPath = libraryRoot();

  if (req.method === 'GET') {
    const action = String(req.query.action || 'list').trim();
    if (action === 'status') {
      // Config-only — avoid extra PROPFIND (browse does the real connection test).
      return res.status(200).json({
        ok: true,
        configured: true,
        rootPath,
        libraryRoot: rootPath,
        libraryLabel: 'PTR Photos',
      });
    }

    if (action === 'test') {
      // Real PROPFIND against the library root — powers the "Connected to
      // PTR Photos" status bar in the Product Loader.
      try {
        const result = await testNutstoreConnection();
        return res.status(200).json({
          ok: true,
          configured: true,
          connected: result?.ok !== false,
          rootPath,
          libraryLabel: result?.libraryLabel || 'PTR Photos',
        });
      } catch (err) {
        return res.status(200).json({
          ok: false,
          configured: true,
          connected: false,
          rootPath,
          libraryLabel: 'PTR Photos',
          error: formatNutstoreError(err),
        });
      }
    }

    const path = clampToLibrary(req.query.path || rootPath);
    const requestHref = String(req.query.href || '').trim() || null;
    const recursive = String(req.query.recursive || '').trim() === '1';
    const q = String(req.query.q || '').trim().toLowerCase();

    try {
      if (recursive) {
        const { images, count, truncated } = await listNutstoreImagesRecursive(path);
        const filtered = q
          ? images.filter((img) => img.name.toLowerCase().includes(q) || img.path.toLowerCase().includes(q))
          : images;
        return res.status(200).json({
          path,
          recursive: true,
          entries: filtered,
          count: filtered.length,
          libraryRoot: rootPath,
          truncated,
        });
      }

      const { entries, cached } = await listNutstoreDirectory(path, { requestHref });
      const filtered = q
        ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
        : entries;
      return res.status(200).json({
        path,
        recursive: false,
        entries: filtered,
        libraryRoot: rootPath,
        cached: Boolean(cached),
      });
    } catch (err) {
      return res.status(nutstoreErrorStatus(err)).json({
        error: formatNutstoreError(err),
        rateLimited: isNutstoreRateLimitError(err),
      });
    }
  }

  return res.status(405).end();
}
