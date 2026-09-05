import { requireOwner } from './_admin-auth.js';

/**
 * The legacy bulk image-replace route wrote directly to the public product
 * bucket and Product Manager. That bypassed the Image Processing Centre's
 * private review, approval, archive and production-only apply controls.
 *
 * Keep the route as an authenticated tombstone so stale clients receive an
 * explicit migration response instead of falling through to a generic 404.
 * Image changes must use /api/image-processing-jobs.
 */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  return res.status(410).json({
    error: 'legacy_image_replace_retired',
    message: 'Use the Image Processing Centre for reviewed image changes.',
    replacement: '/api/image-processing-jobs',
  });
}
