/**
 * ERP / Positill SQL access — **read-only only. Never write.**
 *
 * All direct SQL and bridge paths must:
 * - use hardcoded SELECT statements (validated here)
 * - connect with readOnlyIntent + ProtoSyncReadOnly
 * - never accept arbitrary SQL from callers
 */

export const FORBIDDEN_SQL_TOKENS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE', 'MERGE', 'TRUNCATE',
  'EXEC', 'EXECUTE', 'BACKUP', 'RESTORE', 'GRANT', 'REVOKE', 'DENY',
]);

export function assertReadOnlySql(sqlText) {
  const upper = String(sqlText || '').trim().toUpperCase();
  if (!upper.startsWith('SELECT')) {
    throw new Error('Blocked SQL: only SELECT is allowed');
  }
  for (const token of FORBIDDEN_SQL_TOKENS) {
    if (upper.includes(token)) {
      throw new Error(`Blocked SQL token: ${token}`);
    }
  }
}

export function mssqlReadOnlyConfig(overrides = {}) {
  const password = String(process.env.SQL_PASSWORD || '').trim();
  if (!password) return null;

  return {
    server: process.env.SQL_SERVER || 'BLADERUNNER-PC',
    database: process.env.SQL_DATABASE || 'POSWINSQL',
    user: process.env.SQL_USER || 'ProtoSyncReadOnly',
    password,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      readOnlyIntent: true,
    },
    connectionTimeout: 20000,
    requestTimeout: 25000,
    ...overrides,
  };
}
