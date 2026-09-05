#!/usr/bin/env node
/**
 * Test SQL bridge /top-sellers (Positill sales) — LAN or production tunnel.
 *
 * Requires in .env.local (or env):
 *   STOCK_SQL_BRIDGE_URL=http://192.168.10.10:8765
 *   STOCK_SQL_BRIDGE_KEY=<shared-secret>
 *
 * Usage:
 *   node scripts/test-bridge-top-sellers.mjs
 *   node scripts/test-bridge-top-sellers.mjs yesterday 5
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnvLocal() {
  for (const name of ['.env.local', '.env']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadEnvLocal();

const period = String(process.argv[2] || 'today');
const limit = Number(process.argv[3] || 10);
const base = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim().replace(/\/$/, '');
const key = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();

console.log('=== SQL Bridge /top-sellers Test ===\n');
console.log('Period:', period);
console.log('Limit:', limit);
console.log('Bridge URL:', base || '(not set)');
console.log('Bridge key:', key ? 'set' : 'missing');

if (!base) {
  console.error('\nSet STOCK_SQL_BRIDGE_URL in .env.local');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
if (key) headers['x-api-key'] = key;

const started = Date.now();
try {
  const res = await fetch(`${base}/top-sellers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ period, scope: 'top_sellers', limit }),
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json().catch(() => ({}));
  console.log('\nHTTP:', res.status, `(${Date.now() - started}ms)`);

  if (!res.ok) {
    console.error('Error:', json.error || json.message || res.statusText);
    process.exit(1);
  }

  const items = json.items || [];
  console.log('Invoice headers:', json.invoiceHeaderCount ?? '—');
  console.log('Period label:', json.periodLabel ?? period);
  console.log('Top items:', items.length);
  for (const row of items.slice(0, 5)) {
    console.log(`  ${row.code} — ${String(row.title || '').slice(0, 40)} — qty ${row.totalQty}`);
  }
  if (!items.length) {
    console.log('\nWARN: No line items (may be no sales in period)');
  }
  console.log('\nSUCCESS: /top-sellers returned Positill aggregates (SELECT-only)');
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exit(1);
}
