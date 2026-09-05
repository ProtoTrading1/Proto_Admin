/**
 * push-taxonomy.mjs
 * Uploads the new categories.json to Supabase Storage (site-config bucket)
 * so both portals pick it up live without a redeploy.
 *
 * Usage:
 *   VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/push-taxonomy.mjs
 *   or with a .env file: node --env-file=.env scripts/push-taxonomy.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CATEGORIES_PATH = join(__dir, '../src/data/categories.json');
const BUCKET = 'site-config';
const FILE = 'taxonomy/categories.json';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const categories = JSON.parse(readFileSync(CATEGORIES_PATH, 'utf8'));

function countNodes(nodes) {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children || []), 0);
}

console.log(`Loaded ${categories.length} top-level categories, ${countNodes(categories)} total nodes.`);

// Ensure bucket exists
await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});

const payload = JSON.stringify({ categories, updatedAt: new Date().toISOString() });
const { error } = await supabase.storage.from(BUCKET).upload(FILE, payload, {
  contentType: 'application/json',
  upsert: true,
});

if (error) {
  console.error('Upload failed:', error.message);
  process.exit(1);
}

console.log(`✓ Taxonomy pushed to ${BUCKET}/${FILE}`);
console.log('Both portals will serve the new tree within 60 seconds (cache TTL).');
