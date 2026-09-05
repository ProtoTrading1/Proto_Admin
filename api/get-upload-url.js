import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'product-images';

function getClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const sb = getClient();
  const path = `${Date.now()}-${String(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  // Ensure bucket exists
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(400).json({ error: error.message });

  const publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  return res.status(200).json({ signedUrl: data.signedUrl, path, publicUrl });
}
