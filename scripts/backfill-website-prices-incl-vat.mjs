#!/usr/bin/env node
/**
 * Copy products.sell_price → website_stock.price (no VAT transform).
 * Run after migration 034 or whenever ERP prices need a bulk push to the catalogue.
 *
 *   node scripts/backfill-website-prices-incl-vat.mjs
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.STOCK_SUPABASE_POOLER_URL
  || process.env.STOCK_SUPABASE_URL
  || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY || process.env.VITE_STOCK_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing STOCK_SUPABASE_URL / STOCK_SUPABASE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function backfillTable(table) {
  const { data, error } = await sb.rpc('sync_website_from_products');
  if (error) throw error;
  return data;
}

const result = await backfillTable();
console.log(JSON.stringify({ sync: result }, null, 2));
