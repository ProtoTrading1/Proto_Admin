#!/usr/bin/env node
/**
 * One-time: restore all archived_products rows with archived_by = 'auto-oos' to live.
 *
 * Usage: VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node scripts/restore-auto-oos-to-live.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { restoreArchivedToLive } from '../api/_ensure-product.js';

const BATCH = 25;
const url = process.env.STOCK_SUPABASE_URL || process.env.VITE_STOCK_SUPABASE_URL;
const key = process.env.STOCK_SUPABASE_KEY || process.env.VITE_STOCK_SUPABASE_KEY;

if (!url || !key) {
  console.error('Missing stock Supabase env vars');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAutoOosSkus() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('archived_products')
      .select('sku')
      .eq('archived_by', 'auto-oos')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return rows.map((r) => r.sku).filter(Boolean);
}

async function main() {
  const skus = await fetchAutoOosSkus();
  console.log(`Found ${skus.length} auto-oos archived rows to restore`);

  let ok = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < skus.length; i += BATCH) {
    const chunk = skus.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (sku) => {
      try {
        const result = await restoreArchivedToLive(sb, sku);
        ok += 1;
        if (result.alreadyLive) {
          console.log(`  ${sku}: already live`);
        }
      } catch (err) {
        failed += 1;
        errors.push({ sku, error: err.message });
        console.error(`  ${sku}: ${err.message}`);
      }
    }));
    console.log(`Progress: ${Math.min(i + BATCH, skus.length)}/${skus.length}`);
  }

  console.log(`Done — restored: ${ok}, failed: ${failed}`);
  if (errors.length) {
    console.log('Failures:', JSON.stringify(errors.slice(0, 20), null, 2));
    if (errors.length > 20) console.log(`… and ${errors.length - 20} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
