import { requireAdminOrOrderToken } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { loadTaxonomy, resolveCategoryIds } from './_taxonomy-utils.js';

/**
 * Replacement-product search for the fulfilment page.
 *
 * The page used to pull the ENTIRE catalogue from /api/products and fuzzy
 * filter it in the browser — a multi-megabyte download on a warehouse phone,
 * and far more than a packer needs to swap one line. This searches server-side
 * and returns only the handful of fields the swap panel renders, so a signed
 * order link never carries the whole product table with it.
 */

const MAX_RESULTS = 10;
const CATEGORY_SELECT = 'sku, barcode, title, price, image_url_one, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four';

/** PostgREST `or=` filters are comma/parenthesis delimited — strip both. */
function escapeSearchTerm(term) {
  return String(term || '').replace(/[%,()\\'"]/g, ' ').trim();
}

export default async function handler(req, res) {
  if (!(await requireAdminOrOrderToken(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const term = escapeSearchTerm(req.query?.q);
  if (term.length < 2) return res.status(200).json({ rows: [] });

  try {
    const supabase = getStockClient();
    const [{ data, error }, tree] = await Promise.all([
      supabase
        .from('website_stock')
        .select(CATEGORY_SELECT)
        .or(`title.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%`)
        .order('title', { ascending: true })
        .limit(MAX_RESULTS),
      loadTaxonomy().catch(() => []),
    ]);
    if (error) throw error;

    const rows = (data || []).map((row) => {
      const { categoryId } = resolveCategoryIds(row, tree);
      return {
        id: row.sku,
        code: row.barcode || row.sku,
        name: row.title,
        image: row.image_url_one || '',
        price: Number(row.price) || 0,
        category: categoryId,
        categoryLabel: row.category || 'Other',
      };
    });
    return res.status(200).json({ rows });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Product search failed' });
  }
}
