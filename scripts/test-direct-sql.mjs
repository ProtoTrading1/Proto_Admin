#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, '.env.local');
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

console.log('SQL_SERVER:', process.env.SQL_SERVER || 'BLADERUNNER-PC');
console.log('SQL_USER:', process.env.SQL_USER || 'ProtoSyncReadOnly');
console.log('SQL_PASSWORD set:', Boolean(String(process.env.SQL_PASSWORD || '').trim()));
console.log('Password is placeholder:', String(process.env.SQL_PASSWORD || '').trim() === 'PASTE_HERE');

const { fetchStmastRow } = await import('../api/_sql-stmast.js');
try {
  const row = await fetchStmastRow('8626100145');
  console.log('SUCCESS:', row ? { CODE: row.CODE, DESCR: String(row.DESCR || '').slice(0, 50) } : 'no row');
} catch (err) {
  console.error('FAILED:', err.message);
  if (err.originalError) console.error('original:', err.originalError.message);
  process.exit(1);
}
