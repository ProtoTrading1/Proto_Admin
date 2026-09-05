import { requireAdminKey } from './_admin-auth.js';
import { uploadTransformedImage } from './_image-pipeline.js';

// Pasted screenshots / drag-dropped photos can be several MB as base64.
export const config = { api: { bodyParser: { sizeLimit: '12mb' } } };

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { base64, contentType = 'image/jpeg' } = req.body || {};
  if (!base64) return res.status(400).json({ error: 'base64 is required' });

  try {
    const buffer = Buffer.from(String(base64), 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Empty image data' });
    const url = await uploadTransformedImage(buffer, `ref-${Date.now()}.jpg`, contentType);
    return res.status(200).json({ ok: true, url });
  } catch (err) {
    console.error('upload-reference-image:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
