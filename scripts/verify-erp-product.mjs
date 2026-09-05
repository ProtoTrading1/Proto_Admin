#!/usr/bin/env node
/**
 * Capability 1.1 — verify live Product Truth via SQL bridge.
 * Usage: node scripts/verify-erp-product.mjs [SKU]
 * Requires STOCK_SQL_BRIDGE_URL + STOCK_SQL_BRIDGE_KEY (or SQL_PASSWORD on LAN) in .env.local
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnvLocal() {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
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

const sku = String(process.argv[2] || process.env.VERIFY_ERP_SKU || '8626100145').trim().toUpperCase();
const bridgeUrl = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim();
const bridgeKey = Boolean(String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim());
const sqlPassword = Boolean(String(process.env.SQL_PASSWORD || '').trim());

const { executeQuery } = await import('../api/intelligence/query-engine/execute.js');
const { buildProductContext } = await import('../api/intelligence/bi/contexts/product.js');
const { isStmastAccessConfigured } = await import('../api/_sql-stmast.js');

let bridgeOk = false;
let bridgeError = null;

console.log('=== Capability 1.1 — Live Product Truth ===\n');
console.log('SKU:', sku);
console.log('.env.local loaded:', existsSync(join(root, '.env.local')));
console.log('Bridge URL configured:', Boolean(bridgeUrl));
console.log('Bridge key configured:', bridgeKey);
console.log('Direct SQL configured:', sqlPassword);
console.log('STMAST access configured:', isStmastAccessConfigured());

if (!isStmastAccessConfigured()) {
  console.log('\n⚠️  Add to .env.local:');
  console.log('   STOCK_SQL_BRIDGE_URL=https://<tunnel-host>:8765');
  console.log('   STOCK_SQL_BRIDGE_KEY=<shared-secret>');
  console.log('   (On BLADERUNNER: python scripts/sql-stmast-bridge.py)');
}

if (bridgeUrl) {
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (bridgeKey) headers['x-api-key'] = process.env.STOCK_SQL_BRIDGE_KEY;
    const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/stmast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sku }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    console.log('\nBridge HTTP:', res.status);
    if (res.ok && (json.row || json.code)) {
      bridgeOk = true;
      console.log('Bridge health: OK');
    } else {
      bridgeError = json.error || json.message || `HTTP ${res.status}`;
      console.log('Bridge health: FAIL —', bridgeError);
    }
  } catch (err) {
    bridgeError = err.message;
    console.log('Bridge health: FAIL —', bridgeError);
  }
}

const erpRes = await executeQuery('erp.product_by_code', { code: sku }, { bypassCache: true });
console.log('\n--- erp.product_by_code ---');
console.log('ok:', erpRes.ok);
console.log('source:', erpRes.meta?.source);
console.log('dataSource:', erpRes.data?.dataSource);
console.log('warnings:', erpRes.meta?.warnings);
if (erpRes.data?.product) {
  const p = erpRes.data.product;
  console.log('product:', { code: p.code, title: p.title?.slice(0, 50), onhand: p.onhand, dept: p.dept });
}

const ctxRes = await buildProductContext({ code: sku }, { bypassCache: true });
console.log('\n--- Product Context ---');
console.log('ok:', ctxRes.ok);
console.log('liveErp:', ctxRes.data?.liveErp);
console.log('erpDataSource:', ctxRes.data?.erpDataSource);
console.log('meta.source:', ctxRes.meta?.source);
console.log('evidence keys:', Object.keys(ctxRes.data?.evidence || {}));
if (ctxRes.data?.evidence?.title) {
  console.log('evidence.title:', ctxRes.data.evidence.title);
}

const ev = ctxRes.data?.evidence || {};
const hasTrustShape = (field) =>
  field && typeof field === 'object' && 'value' in field && 'source' in field && 'timestamp' in field && 'confidence' in field;

const engineeringOk = ctxRes.ok && hasTrustShape(ev.title) && Object.keys(ev).length >= 5;
const operationalOk = ctxRes.data?.erpDataSource === 'erp_sql' && ctxRes.data?.liveErp === true;

console.log('\n--- Capability 1.1 graduation ---');
console.log('Engineering:', engineeringOk ? 'GRADUATED ✓' : 'INCOMPLETE');
console.log('Operational:', operationalOk ? 'VERIFIED ✓' : 'AWAITING BRIDGE (erp_sql)');

if (!engineeringOk) {
  console.log('\nEngineering gate failed — evidence or context incomplete.');
  process.exit(1);
}

if (!operationalOk) {
  console.log('\nOperational: configure bridge, re-run — expect dataSource: erp_sql');
  console.log('Set VERIFY_ERP_REQUIRE_LIVE=1 to fail exit until operational passes.');
}

if (process.env.VERIFY_ERP_REQUIRE_LIVE === '1' && !operationalOk) {
  process.exit(1);
}

process.exit(0);
