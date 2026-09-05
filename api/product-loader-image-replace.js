import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const BUCKET = 'product-images';
const SLOT_COLS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

function getStockAdminClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items[] required' });
  }

  const supabase = getStockAdminClient();
  await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  const results = [];
  for (const raw of items) {
    const sku = String(raw.sku || '').trim().toUpperCase();
    const slot = Math.min(4, Math.max(1, Number(raw.imageSlot) || 1));
    const filename = String(raw.filename || `${sku}-${slot}.jpg`);
    const contentType = String(raw.contentType || 'image/jpeg');
    const base64 = String(raw.base64 || '');

    if (!sku || !base64) {
      results.push({ sku, ok: false, error: 'sku and base64 required' });
      continue;
    }

    try {
      const { data: row, error: fetchErr } = await supabase
        .from('website_stock')
        .select('sku')
        .eq('sku', sku)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!row) {
        results.push({ sku, ok: false, error: 'not_in_website_stock' });
        continue;
      }

      const ext = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const objectPath = `${sku}/${slot}.${ext}`;
      const buffer = Buffer.from(base64, 'base64');
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(objectPath, buffer, { contentType, upsert: true });
      if (uploadErr) throw uploadErr;

      const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
      const col = SLOT_COLS[slot - 1];
      const { error: patchErr } = await supabase
        .from('website_stock')
        .update({ [col]: publicUrl, updated_at: new Date().toISOString() })
        .eq('sku', sku);
      if (patchErr) throw patchErr;

      results.push({ sku, ok: true, slot, url: publicUrl });
    } catch (err) {
      results.push({ sku, ok: false, error: err.message || 'replace failed' });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return res.status(failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    replaced: results.filter((r) => r.ok).length,
    failed,
    results,
  });
}
