import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

const BUCKET = 'product-images';

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

  const { filename, contentType, base64, sku, imageSlot, requireNew = false } = req.body || {};
  if (!filename || !contentType || !base64) {
    return res.status(400).json({ error: 'filename, contentType, and base64 are required' });
  }

  const supabase = getStockAdminClient();

  const safeSku = String(sku || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (requireNew && safeSku) {
    const [{ data: existing, error: lookupError }, { data: archived, error: archiveLookupError }] = await Promise.all([
      supabase.from('website_stock').select('sku').eq('sku', safeSku).maybeSingle(),
      supabase.from('archived_products').select('sku').eq('sku', safeSku).maybeSingle(),
    ]);
    if (lookupError || archiveLookupError) return res.status(500).json({ error: lookupError?.message || archiveLookupError?.message });
    if (existing || archived) {
      return res.status(409).json({
        error: `This SKU already exists ${existing ? 'on the website' : 'in Archive'}. Its images were not changed.`,
        code: 'exists',
      });
    }
  }

  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  const buffer = Buffer.from(base64, 'base64');
  const slot = Math.min(4, Math.max(1, Number(imageSlot) || 1));
  const ext = String(filename).split('.').pop()?.toLowerCase() || 'jpg';
  const objectPath = safeSku
    ? `${safeSku}/${slot}.${ext.replace(/[^a-z0-9]/g, '')}`
    : `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    // requireNew already performed the authoritative live + Archive lookup
    // above. If no product row exists, an object at this path is an orphan
    // left by a permanently deleted/failed intake and is safe to replace.
    // Existing product images remain protected by the 409 guard.
    .upload(objectPath, buffer, { contentType, upsert: Boolean(safeSku) });

  if (error) return res.status(400).json({ error: error.message });

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);

  return res.status(200).json({ url: publicUrl, path: objectPath });
}
