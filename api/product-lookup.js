import { requireAdminOrOrderToken } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { loadTaxonomy, resolveCategoryIds } from './_taxonomy-utils.js';

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export default async function handler(req, res) {
  if (!(await requireAdminOrOrderToken(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const ids = [...new Set((req.body?.ids || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return res.status(200).json({});

  try {
    const supabase = getStockClient();
    const [{ data, error }, tree] = await Promise.all([
      supabase
        .from('website_stock')
        .select('sku, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
        .in('sku', ids),
      loadTaxonomy().catch(() => []),
    ]);
    if (error) throw error;

    const map = {};
    (data || []).forEach((row) => {
      const { categoryId } = resolveCategoryIds(row, tree);
      map[row.sku] = {
        category: categoryId,
        categoryLabel: row.category || 'Other',
      };
    });
    return res.status(200).json(map);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Lookup failed' });
  }
}
