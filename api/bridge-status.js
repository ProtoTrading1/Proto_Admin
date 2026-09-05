import { requireAdminKey } from './_admin-auth.js';

/**
 * Lightweight bridge health check for the admin header dot. Unlike
 * /api/product-loader-diag (owner-only, exposes env/config detail) this is
 * available to any verified admin and returns only booleans:
 *   { online, configured }
 * online     — the Positill SQL bridge answered a probe just now
 * configured — a bridge/SQL path is set up at all (so red vs grey is meaningful)
 */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const bridgeUrl = String(process.env.STOCK_SQL_BRIDGE_URL || '').trim();
  const bridgeKey = String(process.env.STOCK_SQL_BRIDGE_KEY || '').trim();
  const sqlPassword = String(process.env.SQL_PASSWORD || '').trim();
  const configured = Boolean(bridgeUrl) || Boolean(sqlPassword);

  let online = false;
  const probeSku = '8626100145';
  try {
    if (bridgeUrl) {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (bridgeKey) headers['x-api-key'] = bridgeKey;
      const r = await fetch(`${bridgeUrl}/stmast`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sku: probeSku }),
        signal: AbortSignal.timeout(8000),
      });
      online = r.ok;
    } else if (sqlPassword) {
      const sql = (await import('mssql')).default;
      const pool = await sql.connect({
        server: process.env.SQL_SERVER || 'BLADERUNNER-PC',
        database: process.env.SQL_DATABASE || 'POSWINSQL',
        user: process.env.SQL_USER || 'ProtoSyncReadOnly',
        password: sqlPassword,
        options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true },
        connectionTimeout: 8000,
        requestTimeout: 8000,
      });
      try {
        await pool.request().query('SELECT 1');
        online = true;
      } finally {
        await pool.close();
      }
    }
  } catch {
    online = false;
  }

  return res.status(200).json({ online, configured });
}
