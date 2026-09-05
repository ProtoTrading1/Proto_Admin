import { fetchStmastRow, isStmastAccessConfigured, sqlRowToPreview, toSqlPreview } from './_sql-stmast.js';
import { fetchFromCache } from './_stmast-cache.js';

// Always true — stmast_cache is available via existing Supabase credentials
export function isSqlConfigured() {
  return true;
}

export async function getProductByCode(code) {
  const { product } = await resolveProductByCode(code);
  return product;
}

/**
 * Resolve product from live ERP (bridge/direct SQL) or stmast_cache fallback.
 * @returns {Promise<{ product: object|null, dataSource: 'erp_sql'|'stmast_cache'|null, bridgeAttempted: boolean }>}
 */
export async function resolveProductByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { product: null, dataSource: null, bridgeAttempted: false };

  const bridgeAttempted = isStmastAccessConfigured();

  if (bridgeAttempted) {
    try {
      const row = await fetchStmastRow(normalized);
      if (row) {
        return { product: toSqlPreview(row), dataSource: 'erp_sql', bridgeAttempted: true };
      }
    } catch {
      // bridge unavailable — fall through to cache
    }
  }

  const cached = await fetchFromCache(normalized);
  if (cached) {
    return { product: cached, dataSource: 'stmast_cache', bridgeAttempted };
  }

  return { product: null, dataSource: null, bridgeAttempted };
}

export async function searchProducts(_term) {
  throw new Error('searchProducts not implemented — Phase 2');
}

export async function getSupplierProducts(_supplier) {
  throw new Error('getSupplierProducts not implemented — Phase 2');
}
