#!/usr/bin/env node
/**
 * One-time (and refresh) import of Proto Master Items CSV → Supabase stmast_cache.
 * Run: node scripts/import-stmast-csv.js
 * Re-run any time you export a fresh CSV from Numbers.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env.local manually (no dotenv dependency needed)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '..', '.env.local');
try {
  const envText = readFileSync(envPath, 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '');
  }
} catch (_) {}

const CSV_PATH = process.env.CSV_PATH
  || `${process.env.HOME}/Desktop/Proto Master Upload  2.csv`;

const SUPABASE_URL = process.env.VITE_STOCK_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_STOCK_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_STOCK_SUPABASE_URL or VITE_STOCK_SUPABASE_KEY — run from project root after vercel env pull');
  process.exit(1);
}

const text = readFileSync(CSV_PATH, 'utf8');
const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
const headers = lines[0].split(';').map(h => h.trim().toUpperCase());

const rows = lines.slice(1).map(line => {
  const cols = line.split(';');
  const get = (col) => (cols[headers.indexOf(col)] || '').trim();
  const code = get('CODE');
  if (!code) return null;
  return {
    code,
    descr:    get('DESCR') || null,
    price_a:  parseFloat(get('PRICE_A')) || 0,
    onhand:   parseFloat(get('ONHAND')) || 0,
    booked:   parseFloat(get('BOOKED')) || 0,
    dept:     get('DEPT') || null,
    supplier: get('SUPPLIER') || null,
    barcode:  get('BARCODE') || null,
  };
}).filter(Boolean);

// Deduplicate — keep last occurrence of each code
const deduped = Object.values(
  Object.fromEntries(rows.map(r => [r.code, r]))
);
console.log(`Parsed ${rows.length} rows, ${deduped.length} unique codes from ${CSV_PATH}`);

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BATCH = 500;
let done = 0;
for (let i = 0; i < deduped.length; i += BATCH) {
  const batch = deduped.slice(i, i + BATCH);
  const { error } = await sb
    .from('stmast_cache')
    .upsert(batch, { onConflict: 'code' });
  if (error) {
    console.error(`Error at batch starting row ${i}:`, error.message);
    process.exit(1);
  }
  done += batch.length;
  process.stdout.write(`\r${done}/${deduped.length}`);
}
console.log('\nDone.');
