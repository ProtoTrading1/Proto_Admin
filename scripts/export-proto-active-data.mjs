#!/usr/bin/env node
/**
 * Regenerate data/proto-active-customers.json from Desktop Numbers export.
 *
 * Primary source: ~/Desktop/proto customers fallback.numbers
 * Columns: ACCOUNT, CustomerName, CONTACT, FirstName, EMAIL, SalesLast12Months
 *
 * Usage: node scripts/export-proto-active-data.mjs
 */
import { writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(homedir(), 'Desktop');
const fallbackPath = join(desktop, 'proto customers fallback.numbers');
const outPath = join(dirname(fileURLToPath(import.meta.url)), '../data/proto-active-customers.json');

async function loadNumbers(path) {
  const { Document } = await import('numbers-parser');
  const doc = new Document(path);
  const t = doc.sheets[0].tables[0];
  const rows = [];
  for (let r = 1; r < t.numRows; r++) {
    const acct = String(t.cell(r, 0).value || '').trim().toUpperCase();
    const email = String(t.cell(r, 4).value || '').trim().toLowerCase();
    if (!email || !acct) continue;
    const sales = t.cell(r, 5).value;
    rows.push({
      account_code: acct.slice(0, 6),
      name: String(t.cell(r, 1).value || '').trim(),
      email,
      sales_last_12_months: Number(sales) || 0,
      invoice_count: 0,
      last_purchase_date: null,
      contact_name: String(t.cell(r, 2).value || '').trim(),
      first_name: String(t.cell(r, 3).value || '').trim(),
    });
  }
  return rows;
}

if (!existsSync(fallbackPath)) {
  console.error(`Missing file: ${fallbackPath}`);
  process.exit(1);
}

const merged = await loadNumbers(fallbackPath);
writeFileSync(outPath, JSON.stringify(merged));
const withNames = merged.filter((r) => r.first_name?.trim()).length;
console.log(`Wrote ${merged.length} rows to ${outPath}`);
console.log(`${withNames} with first names, ${merged.length - withNames} blank`);
