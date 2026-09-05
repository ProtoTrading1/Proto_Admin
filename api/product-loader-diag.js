import { requireOwner } from './_admin-auth.js';
import { toSqlPreview } from './_sql-stmast.js';

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const code = String(req.query.code || '8626100145').trim().toUpperCase();

  // --- Env var presence ---
  const bridgeUrl = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim();
  const bridgeKey = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();
  const intakeUrl = String(process.env.IMAGE_INTAKE_SERVICE_URL || '').trim();
  const sqlPassword = String(process.env.SQL_PASSWORD || '').trim();

  const bridgeConfigured = Boolean(bridgeUrl);
  const intakeConfigured = Boolean(intakeUrl);
  const directConfigured = Boolean(sqlPassword);
  const sqlConfigured = bridgeConfigured || intakeConfigured || directConfigured;

  // --- Which provider would be selected ---
  let sqlProvider = 'website_stock_only';
  if (bridgeUrl) sqlProvider = 'bridge';
  else if (intakeUrl) sqlProvider = 'intake';
  else if (sqlPassword) sqlProvider = 'direct';

  // --- Connection test ---
  let sqlConnectionTest = false;
  let sqlError = null;
  let sqlResult = null;
  let bridgeReachable = false;
  let bridgeHttpStatus = null;

  if (sqlConfigured) {
    try {
      if (bridgeUrl) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (bridgeKey) headers['x-api-key'] = bridgeKey;

        const bridgeRes = await fetch(`${bridgeUrl}/stmast`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ sku: code }),
          signal: AbortSignal.timeout(10000),
        });

        bridgeHttpStatus = bridgeRes.status;
        bridgeReachable = true;

        const json = await bridgeRes.json().catch(() => ({}));
        if (!bridgeRes.ok) {
          sqlError = json.error || json.message || `Bridge HTTP ${bridgeRes.status}`;
        } else {
          sqlConnectionTest = true;
          sqlResult = toSqlPreview(json.row || json);
        }
      } else if (sqlPassword) {
        const sql = (await import('mssql')).default;
        const pool = await sql.connect({
          server: process.env.SQL_SERVER || 'BLADERUNNER-PC',
          database: process.env.SQL_DATABASE || 'POSWINSQL',
          user: process.env.SQL_USER || 'ProtoSyncReadOnly',
          password: sqlPassword,
          options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true },
          connectionTimeout: 10000,
          requestTimeout: 10000,
        });
        try {
          const result = await pool.request()
            .input('code', sql.VarChar(64), code)
            .query('SELECT TOP 1 CODE, DESCR FROM dbo.STMAST WHERE CODE = @code');
          sqlConnectionTest = true;
          sqlResult = toSqlPreview(result.recordset?.[0] || null);
        } finally {
          await pool.close();
        }
      }
    } catch (err) {
      sqlError = err.message || String(err);
    }
  }

  return res.status(200).json({
    testedCode: code,
    sqlConfigured,
    sqlProvider,
    sqlConnectionTest,
    sqlResult,
    sqlError,
    bridgeConfigured,
    bridgeUrl: bridgeUrl || null,
    bridgeKeyPresent: Boolean(bridgeKey),
    bridgeReachable,
    bridgeHttpStatus,
    intakeConfigured,
    directConfigured,
  });
}
