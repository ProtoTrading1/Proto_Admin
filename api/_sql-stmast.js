/**
 * Read-only STMAST lookup — same query as product_image_intake.py / Bladerunner sync.
 * **Never write to Positill — SELECT only.**
 */

import { assertReadOnlySql, mssqlReadOnlyConfig } from './_sql-readonly.js';

export function isStmastAccessConfigured() {
  return Boolean(
    String(process.env.STOCK_SQL_BRIDGE_URL || '').trim()
    || String(process.env.IMAGE_INTAKE_SERVICE_URL || '').trim()
    || String(process.env.SQL_PASSWORD || '').trim(),
  );
}

export function stmastSetupMessage() {
  return (
    'STMAST lookup is not reachable from Vercel. On BLADERUNNER-PC run '
    + 'python scripts/sql-stmast-bridge.py, expose port 8765 (Cloudflare Tunnel / Tailscale), '
    + 'then set STOCK_SQL_BRIDGE_URL and STOCK_SQL_BRIDGE_KEY in Vercel. '
    + 'Or set IMAGE_INTAKE_SERVICE_URL for the full office intake service. '
    + 'Upload-only still works for SKUs already in Supabase products when the bridge is offline.'
  );
}

const STMAST_QUERY = `
  SELECT TOP 1 CODE, DESCR, PRICE_A, ONHAND, BOOKED, DEPT
  FROM dbo.STMAST
  WHERE CODE = @code
`;

assertReadOnlySql(STMAST_QUERY);

function normalizeRow(row) {
  if (!row) return null;
  const normalized = {
    CODE: row.CODE ?? row.code,
    DESCR: row.DESCR ?? row.descr ?? row.title ?? row.description,
    PRICE_A: row.PRICE_A ?? row.price_a ?? row.price,
    ONHAND: row.ONHAND ?? row.onhand,
    BOOKED: row.BOOKED ?? row.booked,
    DEPT: row.DEPT ?? row.dept,
  };
  return String(normalized.CODE || '').trim() ? normalized : null;
}

/** Normalize bridge/cache/raw rows into a consistent preview shape for the UI. */
export function toSqlPreview(row) {
  if (!row) return null;
  if (row.title != null && row.code != null && row.DESCR == null && row.descr == null) {
    return {
      code: String(row.code || row.CODE || '').trim(),
      title: String(row.title ?? '').trim(),
      price: Number(row.price ?? row.PRICE_A ?? row.price_a) || 0,
      onhand: Number(row.onhand ?? row.ONHAND) || 0,
      booked: Number(row.booked ?? row.BOOKED) || 0,
      available: Number(row.available ?? ((Number(row.onhand ?? row.ONHAND) || 0) - (Number(row.booked ?? row.BOOKED) || 0))),
      dept: String(row.dept ?? row.DEPT ?? '').trim(),
    };
  }
  return sqlRowToPreview(normalizeRow(row));
}

async function fetchViaBridge(sku) {
  const base = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const key = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();
  if (key) headers['x-api-key'] = key;

  const res = await fetch(`${base}/stmast`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sku }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || json.message || `SQL bridge failed (${res.status})`);
  }
  // The bridge uses `{ row: null }` for an exact CODE miss. Do not fall back
  // to normalising the response envelope itself: that creates a blank,
  // zero-valued product which looks like a real Positill row to callers.
  const row = Object.prototype.hasOwnProperty.call(json, 'row') ? json.row : json;
  return normalizeRow(row);
}

async function fetchViaMssql(sku) {
  const config = mssqlReadOnlyConfig({ requestTimeout: 20000 });
  if (!config) {
    throw new Error(stmastSetupMessage());
  }

  const sql = (await import('mssql')).default;

  const pool = await sql.connect(config);
  try {
    const result = await pool.request()
      .input('code', sql.VarChar(64), sku)
      .query(STMAST_QUERY);
    return normalizeRow(result.recordset?.[0] || null);
  } finally {
    await pool.close();
  }
}

export async function fetchStmastRow(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (!code) return null;

  if (process.env.STOCK_SQL_BRIDGE_URL) {
    return fetchViaBridge(code);
  }
  return fetchViaMssql(code);
}

export function sqlRowToPreview(sqlRow) {
  if (!sqlRow) return null;
  const onhand = Number(sqlRow.ONHAND) || 0;
  const booked = Number(sqlRow.BOOKED) || 0;
  return {
    code: String(sqlRow.CODE || '').trim(),
    title: String(sqlRow.DESCR || '').trim(),
    price: Number(sqlRow.PRICE_A) || 0,
    onhand,
    booked,
    available: onhand - booked,
    dept: String(sqlRow.DEPT || '').trim(),
  };
}
