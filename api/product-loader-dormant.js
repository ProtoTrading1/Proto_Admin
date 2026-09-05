import { createClient } from '@supabase/supabase-js';
import { catalogueDescription, catalogueDisplayTitle } from '../lib/product-loader-display.mjs';
import { requireOwner } from './_admin-auth.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';

const PAGE_SIZE = 1000;
const DORMANT_BY = 'new-products';

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function fetchLiveSkusForRows(sb, rows) {
  const skus = new Set();
  const targets = [...new Set((rows || [])
    .map((row) => String(row?.sku || '').trim().toUpperCase())
    .filter(Boolean))];
  for (let i = 0; i < targets.length; i += PAGE_SIZE) {
    const chunk = targets.slice(i, i + PAGE_SIZE);
    const { data, error } = await sb
      .from('website_stock')
      .select('sku')
      .in('sku', chunk);
    if (error) throw error;
    for (const row of data || []) skus.add(String(row.sku || '').trim().toUpperCase());
  }
  return skus;
}

async function fetchDormantRows(sb) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('archived_products')
      .select('*')
      .eq('archived_by', DORMANT_BY)
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function mapRow(row) {
  return {
    sku: row.sku,
    barcode: row.barcode || row.sku,
    title: row.title || row.sku,
    price: Number(row.price) || 0,
    originalDescription: row.original_description || '',
    category: row.category || '',
    subcategoryOne: row.subcategory_one || '',
    subcategoryTwo: row.subcategory_two || '',
    subcategoryThree: row.subcategory_three || '',
    subcategoryFour: row.subcategory_four || '',
    imageUrlOne: row.image_url_one || '',
    imageUrlTwo: row.image_url_two || '',
    imageUrlThree: row.image_url_three || '',
    imageUrlFour: row.image_url_four || '',
    updatedAt: row.updated_at,
  };
}

async function handleSave(sb, body) {
  const sku = String(body.code || '').trim().toUpperCase();
  if (!sku) return { status: 400, json: { error: 'code is required' } };

  const catalogItem = { code: sku, title: body.title, description: body.description, displayCode: body.displayCode };
  const title = catalogueDisplayTitle(catalogItem);
  const resolvedDescription = catalogueDescription(catalogItem);
  const category = String(body.category || '').trim();
  const subcategoryOne = String(body.subcategoryOne || body.subcategory_one || category).trim();
  if (!category || !subcategoryOne) {
    return { status: 400, json: { error: 'category and subcategoryOne are required' } };
  }

  const now = new Date().toISOString();
  const payload = {
    sku,
    barcode: sku,
    title,
    original_description: resolvedDescription,
    price: Number(body.price) || 0,
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: body.subcategoryTwo || body.subcategory_two || null,
    subcategory_three: body.subcategoryThree || body.subcategory_three || null,
    subcategory_four: body.subcategoryFour || body.subcategory_four || null,
    archived_by: DORMANT_BY,
    archived_at: now,
    updated_at: now,
  };

  const { data: existing } = await sb.from('archived_products').select('sku, archived_by').eq('sku', sku).maybeSingle();
  if (existing && existing.archived_by !== DORMANT_BY) {
    return { status: 409, json: { error: `SKU "${sku}" is archived as "${existing.archived_by}"` } };
  }

  if (existing) {
    const { error } = await sb.from('archived_products').update(payload).eq('sku', sku);
    if (error) return { status: 400, json: { error: error.message } };
  } else {
    const { error } = await sb.from('archived_products').insert(payload);
    if (error) return { status: 400, json: { error: error.message } };
  }

  await logProductLoaderAudit(sb, {
    sku,
    action: 'update',
    source: 'manual_product_loader',
    publishMode: 'dormant',
    newValues: {
      outcome: 'dormant',
      title,
      category,
      subcategoryOne,
      filename: String(body.filename || '').trim() || null,
    },
    publishedBy: String(body.publishedBy || '').trim() || null,
  });

  return { status: 200, json: { ok: true, sku } };
}

async function handleRemove(sb, body) {
  const sku = String(body.code || '').trim().toUpperCase();
  if (!sku) return { status: 400, json: { error: 'code is required' } };
  const { error } = await sb.from('archived_products').delete().eq('sku', sku).eq('archived_by', DORMANT_BY);
  if (error) return { status: 400, json: { error: error.message } };
  return { status: 200, json: { ok: true, sku } };
}

async function handleUpdateCategories(sb, body) {
  const sku = String(body.code || '').trim().toUpperCase();
  if (!sku) return { status: 400, json: { error: 'code is required' } };
  const category = String(body.category || '').trim();
  const subcategoryOne = String(body.subcategoryOne || body.subcategory_one || '').trim();
  if (!category || !subcategoryOne) {
    return { status: 400, json: { error: 'category and subcategoryOne are required' } };
  }

  const patch = {
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: body.subcategoryTwo || body.subcategory_two || null,
    subcategory_three: body.subcategoryThree || body.subcategory_three || null,
    subcategory_four: body.subcategoryFour || body.subcategory_four || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('archived_products')
    .update(patch)
    .eq('sku', sku)
    .eq('archived_by', DORMANT_BY);
  if (error) return { status: 400, json: { error: error.message } };
  return { status: 200, json: { ok: true, sku } };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const sb = getStockClient();

  if (req.method === 'GET') {
    try {
      const rows = await fetchDormantRows(sb);
      const liveSkus = rows.length ? await fetchLiveSkusForRows(sb, rows) : new Set();
      const queue = rows.filter((row) => !liveSkus.has(String(row.sku || '').trim().toUpperCase())).map(mapRow);
      return res.status(200).json({ rows: queue });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to load dormant queue' });
    }
  }

  if (req.method === 'POST') {
    const { action, ...body } = req.body || {};
    try {
      let result;
      if (action === 'save') result = await handleSave(sb, body);
      else if (action === 'remove') result = await handleRemove(sb, body);
      else if (action === 'updateCategories') result = await handleUpdateCategories(sb, body);
      else return res.status(400).json({ error: `Unknown action: ${action || '(missing)'}` });
      return res.status(result.status).json(result.json);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Dormant request failed' });
    }
  }

  return res.status(405).end();
}
