#!/usr/bin/env node
/**
 * Test HTTP SQL bridge (LAN or production tunnel).
 * Usage: node scripts/test-bridge.mjs [SKU]
 *
 * Requires in .env.local:
 *   STOCK_SQL_BRIDGE_URL=http://192.168.10.10:8765  (LAN)
 *   STOCK_SQL_BRIDGE_URL=https://sql-bridge.proto.co.za  (production)
 *   STOCK_SQL_BRIDGE_KEY=<shared-secret>
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnvLocal() {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return false;
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
  return true;
}

loadEnvLocal();

const sku = String(process.argv[2] || '8626100145').trim().toUpperCase();
const base = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim().replace(/\/$/, '');
const key = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();

console.log('=== SQL Bridge Test ===\n');
console.log('SKU:', sku);
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
  const res = await fetch(`${base}/stmast`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sku }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  console.log('\nHTTP:', res.status, `(${Date.now() - started}ms)`);

  if (!res.ok) {
    console.error('Error:', json.error || json.message || res.statusText);
    process.exit(1);
  }

  const row = json.row || json;
  if (!row || (!row.CODE && !row.code)) {
    console.log('No row for SKU');
    process.exit(1);
  }

  console.log('SUCCESS:', {
    code: row.CODE || row.code,
    title: String(row.DESCR || row.descr || '').slice(0, 50),
    onhand: row.ONHAND ?? row.onhand,
    dept: row.DEPT ?? row.dept,
  });
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exit(1);
}
