import { requireOwner } from './_admin-auth.js';
import { Jimp } from 'jimp';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const BUCKET = 'product-images';
/** Reference banner ratio 1000×534 — 2× for retina. */
const TARGET_W = 2000;
const TARGET_H = 1068;

function getStockAdminClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { filename, contentType, base64 } = req.body || {};
  if (!filename || !contentType || !base64) {
    return res.status(400).json({ error: 'filename, contentType, and base64 are required' });
  }

  try {
    const buffer = Buffer.from(base64, 'base64');
    const image = await Jimp.read(buffer);
    const resized = image.cover({ w: TARGET_W, h: TARGET_H });
    const outBuffer = await resized.getBuffer('image/jpeg');

    const supabase = getStockAdminClient();
    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    const safeName = `banner-${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(safeName, outBuffer, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(safeName);
    return res.status(200).json({ url: publicUrl, width: TARGET_W, height: TARGET_H });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to upload banner image' });
  }
}
