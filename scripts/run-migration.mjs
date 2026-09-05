#!/usr/bin/env node
/**
 * Apply a SQL migration file to the stock Supabase database.
 *
 * Requires DATABASE_URL or STOCK_DATABASE_URL (postgres connection string).
 *
 * Usage:
 *   STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/031_website_product_links.sql
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-migration.mjs <path-to.sql>');
  process.exit(1);
}

const dbUrl = process.env.STOCK_DATABASE_URL
  || process.env.DATABASE_URL
  || process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error('Missing STOCK_DATABASE_URL / DATABASE_URL');
  process.exit(1);
}

const sql = readFileSync(resolve(__dirname, '..', file), 'utf8');

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('Install pg: npm install pg');
  process.exit(1);
}

const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  console.log(`Running ${file}...`);
  await client.query(sql);
  console.log('Migration applied.');
} finally {
  await client.end();
}
