/**
 * Positill POS sales aggregates — DBINVDT / DBINVHD on POSWINSQL.
 * **Read-only only — SELECT aggregates. Never write to Positill.**
 */

import { assertReadOnlySql, mssqlReadOnlyConfig } from './_sql-readonly.js';

const ALLOWED_SCOPES = new Set(['top_sellers', 'worst_sellers', 'revenue']);
const ALLOWED_PERIODS = new Set(['today', 'yesterday', 'last_week', 'general']);

/** SAST (UTC+2) business-day boundaries. */
export function sastPeriodBounds(period, now = new Date()) {
  const offsetMs = 2 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const dayStartUtc = new Date(Date.UTC(y, m, d) - offsetMs);

  if (period === 'today') {
    return { start: dayStartUtc, end: now, label: 'today (Positill · SAST)' };
  }
  if (period === 'yesterday') {
    const yStart = new Date(dayStartUtc.getTime() - 24 * 60 * 60 * 1000);
    return { start: yStart, end: dayStartUtc, label: 'yesterday (Positill · SAST)' };
  }
  if (period === 'last_week') {
    return { start: new Date(dayStartUtc.getTime() - 7 * 24 * 60 * 60 * 1000), end: now, label: 'last 7 days (Positill)' };
  }
  if (period === 'general') {
    return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now, label: 'last 30 days (Positill)' };
  }
  return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now, label: 'last 30 days (Positill)' };
}

function orderClause(scope) {
  const s = ALLOWED_SCOPES.has(scope) ? scope : 'top_sellers';
  if (s === 'worst_sellers') return 'SUM(CAST(d.QTY AS float)) ASC';
  if (s === 'revenue') return 'SUM(CAST(d.TOTAL AS float)) DESC';
  return 'SUM(CAST(d.QTY AS float)) DESC';
}

const TOP_SELLERS_SQL = `
  SELECT TOP (@limit)
    d.PRODUCT AS code,
    MAX(d.DESCR) AS title,
    SUM(CAST(d.QTY AS float)) AS totalQty,
    SUM(CAST(d.TOTAL AS float)) AS totalValue,
    COUNT(DISTINCT h.INV_NO) AS invoiceCount
  FROM dbo.DBINVDT d
  INNER JOIN dbo.DBINVHD h ON h.INV_NO = d.INV_NO AND h.TYPE = d.TYPE
  WHERE h.DATE >= @start AND h.DATE < @end
    AND d.PRODUCT IS NOT NULL AND LTRIM(RTRIM(d.PRODUCT)) <> ''
  GROUP BY d.PRODUCT
  ORDER BY {{ORDER}}
`;

const INVOICE_COUNT_SQL = `
  SELECT COUNT(*) AS invoiceCount
  FROM dbo.DBINVHD
  WHERE DATE >= @start AND DATE < @end
`;

function normalizePeriod(period) {
  return ALLOWED_PERIODS.has(period) ? period : 'today';
}

function normalizeItems(rows) {
  return (rows || []).map((row) => ({
    code: String(row.code || row.PRODUCT || '').trim().toUpperCase(),
    title: String(row.title || row.DESCR || row.code || '').trim(),
    name: String(row.title || row.DESCR || row.code || '').trim(),
    totalQty: Number(row.totalQty ?? row.totalqty) || 0,
    totalValue: Number(row.totalValue ?? row.totalvalue) || 0,
    invoiceCount: Number(row.invoiceCount ?? row.invoicecount) || 0,
  })).filter((r) => r.code);
}

export function isPositillSalesConfigured() {
  return Boolean(
    String(process.env.STOCK_SQL_BRIDGE_URL || '').trim()
    || String(process.env.SQL_PASSWORD || '').trim(),
  );
}

async function fetchViaBridge(period, scope, limit) {
  const base = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const key = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();
  if (key) headers['x-api-key'] = key;

  const res = await fetch(`${base}/top-sellers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ period, scope, limit }),
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || json.message || `SQL bridge failed (${res.status})`);
  }
  return {
    items: normalizeItems(json.items),
    invoiceHeaderCount: Number(json.invoiceHeaderCount) || 0,
    periodLabel: json.periodLabel || period,
    dataSource: 'erp_sql',
  };
}

async function fetchViaMssql(period, scope, limit) {
  const config = mssqlReadOnlyConfig();
  if (!config) return null;

  const sql = (await import('mssql')).default;
  const { start, end, label } = sastPeriodBounds(period);
  const query = TOP_SELLERS_SQL.replace('{{ORDER}}', orderClause(scope));
  assertReadOnlySql(query);
  assertReadOnlySql(INVOICE_COUNT_SQL);

  const pool = await sql.connect(config);
  try {
    const cntRes = await pool.request()
      .input('start', sql.DateTime, start)
      .input('end', sql.DateTime, end)
      .query(INVOICE_COUNT_SQL);

    const itemsRes = await pool.request()
      .input('start', sql.DateTime, start)
      .input('end', sql.DateTime, end)
      .input('limit', sql.Int, limit)
      .query(query);

    return {
      items: normalizeItems(itemsRes.recordset),
      invoiceHeaderCount: Number(cntRes.recordset?.[0]?.invoiceCount) || 0,
      periodLabel: label,
      dataSource: 'erp_sql',
    };
  } finally {
    await pool.close();
  }
}

/**
 * @returns {Promise<{ items: object[], invoiceHeaderCount: number, periodLabel: string, dataSource: 'erp_sql' }|null>}
 */
export async function fetchPositillTopSellers({ period = 'today', scope = 'top_sellers', limit = 10 } = {}) {
  const safePeriod = normalizePeriod(period);
  const safeScope = ALLOWED_SCOPES.has(scope) ? scope : 'top_sellers';
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 25);

  if (process.env.STOCK_SQL_BRIDGE_URL) {
    return fetchViaBridge(safePeriod, safeScope, safeLimit);
  }
  return fetchViaMssql(safePeriod, safeScope, safeLimit);
}
