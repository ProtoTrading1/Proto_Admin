import { requireAdminKey } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';

function getClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function stripExt(value) {
  return String(value || '').trim().replace(/\.[^.]+$/, '');
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { websiteSku, title, imageUrl, category, description } = req.body || {};
    const sku = stripExt(websiteSku);
    const name = String(title || sku).trim();
    const image = String(imageUrl || '').trim();
    const cat = String(category || '').trim();

    if (!sku) return res.status(400).json({ error: 'websiteSku is required' });
    if (!image) return res.status(400).json({ error: 'imageUrl is required' });

    const sb = getClient();

    const { data: existing } = await sb.from('website_stock').select('sku').eq('sku', sku).maybeSingle();
    const { data: archived } = await sb.from('archived_products').select('sku').eq('sku', sku).maybeSingle();
    if (existing || archived) {
      return res.status(409).json({ error: `SKU "${sku}" already exists` });
    }

    const { error: insertErr } = await sb.from('website_stock').insert({
      sku,
      barcode: sku,
      title: name,
      original_description: String(description || name).trim(),
      image_url_one: image,
      image_url_two: null,
      category: cat || 'Uncategorised',
      subcategory_one: cat || 'General',
      subcategory_two: null,
      subcategory_three: null,
      subcategory_four: null,
    });
    if (insertErr) return res.status(400).json({ error: insertErr.message });

    const { error: archiveErr } = await sb.rpc('archive_product', { p_sku: sku, p_by: 'new-products' });
    if (archiveErr) return res.status(400).json({ error: archiveErr.message });

    return res.status(200).json({ ok: true, websiteSku: sku });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error in save-dormant-product' });
  }
}
