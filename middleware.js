import { next } from '@vercel/functions';
import { previewReadOnlyBlock } from './lib/preview-read-only.mjs';

export const config = { matcher: '/api/:path*' };

export default async function middleware(request) {
  const enabled = process.env.PREVIEW_READ_ONLY;
  if (enabled !== '1') return next();

  let body = null;
  // This existing endpoint uses POST for both reads and writes. Only its two
  // audited list actions are allowed; malformed/unreadable bodies stay blocked.
  if (request.method === 'POST' && new URL(request.url).pathname === '/api/stock-actions') {
    try {
      const text = await request.clone().text();
      if (text.length <= 65536) body = JSON.parse(text);
    } catch { /* fail closed below */ }
  }
  const block = previewReadOnlyBlock({ method: request.method, url: request.url, body }, enabled);
  if (!block) return next();
  return Response.json({ error: block.error, code: block.code }, {
    status: block.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
