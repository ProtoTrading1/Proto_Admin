#!/usr/bin/env node
/**
 * Backfill public.website_products from website_stock (REST — no SQL migration required).
 *
 * Usage:
 *   VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node scripts/backfill-website-products.mjs
 */

import { createClient } from '@supabase/supabase-js';

const BATCH = 100;
const url = process.env.STOCK_SUPABASE_URL || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY || process.env.VITE_STOCK_SUPABASE_KEY;

if (!url || !key) {
  console.error('Missing stock Supabase env vars');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function leafCategory(row) {
  return row.subcategory_four || row.subcategory_three || row.subcategory_two || row.subcategory_one || '';
}

function toWebsiteProduct(row) {
  const barcode = String(row.barcode || '').trim() || null;
  return {
    website_sku: row.sku,
    barcode,
    title: row.title,
    description: row.original_description,
    category: row.category,
    subcategory: row.subcategory_one,
    leaf_category: leafCategory(row),
    image_url: String(row.image_url_one || '').split(',')[0].trim() || null,
    active: true,
  };
}

async function fetchAllWebsiteStock() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('website_stock')
      .select('sku, barcode, title, original_description, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four, image_url_one')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function main() {
  const rows = await fetchAllWebsiteStock();
  console.log(`website_stock rows: ${rows.length}`);

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(toWebsiteProduct);
    const { error } = await sb.from('website_products').upsert(batch, { onConflict: 'website_sku' });
    if (error) throw error;
    done += batch.length;
    console.log(`Upserted ${done}/${rows.length}`);
  }

  const { data: syncResult, error: syncErr } = await sb.rpc('sync_website_from_products');
  if (syncErr) console.warn('sync_website_from_products:', syncErr.message);
  else console.log('sync:', syncResult);

  const { count } = await sb.from('website_products').select('*', { count: 'exact', head: true });
  console.log(`website_products count: ${count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
