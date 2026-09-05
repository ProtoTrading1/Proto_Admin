import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { loadTaxonomy, resolveCategoryIds } from './_taxonomy-utils.js';

const PAGE_SIZE = 1000;

async function fetchAllRows(supabase, table, orderBy = 'title') {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function readStockField(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function stockFromRow(row) {
  const available = readStockField(row?.available_stock);
  const raw = readStockField(row?.stock_qty);
  const soh = available !== null ? available : raw;
  return { stockOnHand: soh, stockQty: soh, rawStockQty: raw, availableStock: available };
}

function adapt(row, tree) {
  const images = [row.image_url_one, row.image_url_two, row.image_url_three, row.image_url_four].filter(Boolean);
  const { categoryId, categoryPath } = resolveCategoryIds(row, tree);
  const stock = stockFromRow(row);
  return {
    id: row.sku,
    code: row.barcode,
    barcode: row.barcode,
    websiteSku: row.sku,
    sku: row.sku,
    parentSku: null,
    name: row.title,
    title: row.title,
    description: row.original_description || '',
    price: Number(row.price) || 0,
    images,
    image: images[0] || '',
    secondaryImage: images[1] || '',
    imageThree: images[2] || '',
    imageFour: images[3] || '',
    stockQty: stock.stockQty,
    stockOnHand: stock.stockOnHand,
    colour: '',
    category: categoryId,
    categoryLabel: row.category,
    categoryPath,
    tags: [],
    badges: [],
    isNew: false,
    isSpecial: false,
    isArchived: false,
    sortOrder: 0,
    minQty: Math.max(1, Math.min(9999, Math.floor(Number(row.min_order_qty) || 1))),
    casePack: '',
    marginCue: '',
    leadTime: '',
    tradeNote: '',
    inStock: stock.stockOnHand !== null ? stock.stockOnHand > 0 : true,
    createdAt: row.created_at,
    yearlySales: 0,
    supplier: '',
  };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(
      process.env.VITE_STOCK_SUPABASE_URL,
      process.env.VITE_STOCK_SUPABASE_KEY,
    );

    const [rows, tree] = await Promise.all([
      fetchAllRows(supabase, 'website_stock'),
      loadTaxonomy().catch(() => []),
    ]);
    const products = rows.map((r) => adapt(r, tree));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(products);
  } catch (err) {
    console.error('products api error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch products' });
  }
}
