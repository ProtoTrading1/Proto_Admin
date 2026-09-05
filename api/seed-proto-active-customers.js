import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import seedData from '../data/proto-active-customers.json' with { type: 'json' };

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function loadSeedRows() {
  if (!Array.isArray(seedData) || !seedData.length) {
    throw new Error('Seed file missing or empty — redeploy admin with data/proto-active-customers.json');
  }
  return seedData;
}

function normalizeRow(row) {
  const email = String(row.email || '').trim().toLowerCase();
  const accountCode = String(row.account_code || '').trim().toUpperCase().slice(0, 6);
  if (!email || !accountCode) return null;
  let lastPurchase = row.last_purchase_date || null;
  if (lastPurchase && lastPurchase.includes(' ')) lastPurchase = lastPurchase.slice(0, 10);
  return {
    account_code: accountCode,
    name: String(row.name || '').trim() || email,
    email,
    contact_name: String(row.contact_name || '').trim() || null,
    first_name: String(row.first_name || '').trim() || null,
    sales_last_12_months: Number(row.sales_last_12_months) || 0,
    invoice_count: Number(row.invoice_count) || 0,
    last_purchase_date: lastPurchase || null,
  };
}

/** One row per email — keeps highest 12mo sales when the source file has duplicates. */
function dedupeByEmail(rows) {
  const byEmail = new Map();
  let skipped = 0;
  for (const row of rows) {
    const prev = byEmail.get(row.email);
    if (!prev) {
      byEmail.set(row.email, row);
      continue;
    }
    skipped += 1;
    const keepCurrent =
      row.sales_last_12_months > prev.sales_last_12_months
      || (row.sales_last_12_months === prev.sales_last_12_months && (row.first_name || '') && !(prev.first_name || ''));
    if (keepCurrent) byEmail.set(row.email, row);
  }
  return { rows: [...byEmail.values()], skipped };
}

/** Keep manually-entered names when re-syncing rows that have no name in the seed file. */
async function preserveManualNames(sb, rows) {
  const existing = new Map();
  const emails = rows.map((r) => r.email);
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const { data } = await sb
      .from('proto_active_customers')
      .select('email, contact_name, first_name')
      .in('email', chunk);
    for (const row of data || []) existing.set(row.email, row);
  }
  return rows.map((row) => {
    const prev = existing.get(row.email);
    if (!prev) return row;
    return {
      ...row,
      contact_name: row.contact_name || prev.contact_name || null,
      first_name: row.first_name || prev.first_name || null,
    };
  });
}
/** One-time / refresh import of proto active allowlist from bundled JSON. */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const sb = getAdminClient();
    const raw = loadSeedRows();
    const normalized = raw.map(normalizeRow).filter(Boolean);
    if (!normalized.length) return res.status(400).json({ error: 'No rows in seed file' });

    const { rows: deduped, skipped } = dedupeByEmail(normalized);
    const rows = await preserveManualNames(sb, deduped);
    const withNames = rows.filter((r) => r.first_name).length;

    const BATCH = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await sb
        .from('proto_active_customers')
        .upsert(chunk, { onConflict: 'email' });
      if (error) throw error;
      upserted += chunk.length;
    }

    return res.status(200).json({
      ok: true,
      upserted,
      total: rows.length,
      withNames,
      missingNames: rows.length - withNames,
      skippedDuplicates: skipped,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('seed-proto-active-customers:', msg);
    if (/proto_active_customers_account_code_unique/i.test(msg)) {
      return res.status(409).json({
        error: 'Database still has a unique index on account_code — multiple customers can share the same 6-letter code (e.g. FRIEND). Run migration 023 in Supabase SQL Editor, then sync again.',
        sql: 'DROP INDEX IF EXISTS public.proto_active_customers_account_code_unique_idx;',
      });
    }
    return res.status(500).json({ error: msg || 'Seed failed' });
  }
}
