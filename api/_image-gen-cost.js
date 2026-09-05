import { randomUUID } from 'crypto';
import { readSiteConfigJson, writeSiteConfigJson } from './_site-config.js';
import { getStockClient } from './_stock-client.js';
import { MAX_CONCURRENT_TRANSFORMS } from './_image-gen-constants.js';
import {
  acquireImageGenLockDb,
  releaseImageGenLockDb,
  acquireTransformSemaphoreDb,
  releaseTransformSemaphoreDb,
  registerImageGenBatchDb,
  updateImageGenBatchDb,
  listActiveImageGenStateDb,
  isMissingTableError,
} from './_image-gen-db-locks.js';
import { maybeSendImageGenBudgetAlerts } from './_image-gen-budget.js';

const USD_TO_ZAR_FALLBACK = 18.0;
const COSTS_FILE = 'image-gen/cost-logs.json';
const LOCKS_FILE = 'image-gen/locks.json';
const BATCHES_FILE = 'image-gen/batches.json';
const SEMAPHORE_FILE = 'image-gen/semaphore.json';
const MAX_LOGS = 500;

/** Approximate OpenRouter pricing — fallback when usage.cost is missing from API. */
const MODEL_PRICING = {
  'google/gemini-3-pro-image-preview': { inPerM: 0.10, outPerM: 0.40, imagePerCall: 0.55 },
  'google/gemini-2.5-flash-image': { inPerM: 0.075, outPerM: 0.30, imagePerCall: 0.04 },
  'google/gemini-2.5-flash': { inPerM: 0.075, outPerM: 0.30, imagePerCall: 0 },
  'google/gemini-flash-1.5': { inPerM: 0.075, outPerM: 0.30, imagePerCall: 0 },
};

let cachedFxRate = null;
let cachedFxAt = 0;

export { getStockClient };
export { MAX_CONCURRENT_TRANSFORMS } from './_image-gen-constants.js';

async function readStore(file, fallback) {
  try {
    const data = await readSiteConfigJson(file, fallback);
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeStore(file, payload) {
  await writeSiteConfigJson(file, payload);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Read-modify-write with optimistic retry — prevents lost lock updates when
 * multiple admins run image-analysis batches at the same time.
 */
async function mutateStore(file, fallback, mutator, { maxRetries = 10 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const store = await readStore(file, fallback);
    const version = store.updatedAt || null;
    const result = await mutator({ ...store });

    if (result === false || result?.abort) return result;

    const next = result?.store ?? result;
    const current = await readStore(file, fallback);
    if ((current.updatedAt || null) !== version && attempt < maxRetries - 1) {
      await sleep(40 + attempt * 60 + Math.random() * 80);
      continue;
    }

    try {
      await writeStore(file, next);
      return result?.store ? result : next;
    } catch (err) {
      lastErr = err;
      await sleep(40 + attempt * 60);
    }
  }
  throw lastErr || new Error('Concurrent update conflict — try again shortly');
}

function normalizeLog(row) {
  return {
    id: row.id || randomUUID(),
    created_at: row.created_at || row.createdAt || new Date().toISOString(),
    sku: row.sku || null,
    slot: row.slot ?? null,
    operation: row.operation || 'transform',
    model: row.model || null,
    image_style: row.image_style || row.imageStyle || null,
    tokens_in: Number(row.tokens_in ?? row.tokensIn ?? 0),
    tokens_out: Number(row.tokens_out ?? row.tokensOut ?? 0),
    cost_usd: Number(row.cost_usd ?? row.costUsd ?? 0),
    cost_zar: Number(row.cost_zar ?? row.costZar ?? 0),
    cost_source: row.cost_source || row.costSource || 'estimated',
    processing_ms: row.processing_ms ?? row.processingMs ?? null,
    operator: row.operator || null,
    batch_id: row.batch_id || row.batchId || null,
    status: row.status || 'ok',
    error: row.error || null,
  };
}

export async function fetchUsdToZarRate() {
  const now = Date.now();
  if (cachedFxRate && (now - cachedFxAt) < 6 * 60 * 60 * 1000) return cachedFxRate;
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=USD&to=ZAR');
    if (!response.ok) throw new Error(`FX ${response.status}`);
    const payload = await response.json();
    const rate = Number(payload?.rates?.ZAR);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid ZAR rate');
    cachedFxRate = rate;
    cachedFxAt = now;
    return rate;
  } catch {
    return cachedFxRate || USD_TO_ZAR_FALLBACK;
  }
}

export function estimateImageGenCost({ model = '', tokensIn = 0, tokensOut = 0, isImageOutput = false } = {}) {
  const key = String(model || '').trim();
  const pricing = MODEL_PRICING[key] || { inPerM: 0.10, outPerM: 0.40, imagePerCall: isImageOutput ? 0.45 : 0 };
  const tokenCost = ((tokensIn / 1e6) * pricing.inPerM) + ((tokensOut / 1e6) * pricing.outPerM);
  const imageCost = isImageOutput ? (pricing.imagePerCall || 0) : 0;
  return parseFloat((tokenCost + imageCost).toFixed(6));
}

/** Prefer OpenRouter-reported cost; fall back to local estimate. */
export function resolveImageGenCost({
  model = '',
  tokensIn = 0,
  tokensOut = 0,
  costUsd = null,
  isImageOutput = false,
} = {}) {
  if (costUsd != null && Number.isFinite(Number(costUsd))) {
    return { costUsd: Number(costUsd), costSource: 'openrouter' };
  }
  return {
    costUsd: estimateImageGenCost({ model, tokensIn, tokensOut, isImageOutput }),
    costSource: 'estimated',
  };
}

export function extractImageGenMeta(req) {
  return {
    operator: String(req.headers['x-image-gen-operator'] || req.body?.operator || 'Unknown').trim().slice(0, 64) || 'Unknown',
    batchId: String(req.headers['x-image-gen-batch-id'] || req.body?.batchId || '').trim().slice(0, 64) || null,
  };
}

export async function logImageGenCost(sb, entry) {
  const usdToZar = entry.usdToZar ?? await fetchUsdToZarRate();
  const costUsd = Number(entry.costUsd ?? entry.cost_usd ?? 0);
  const costZar = Number(entry.costZar ?? entry.cost_zar ?? (costUsd * usdToZar).toFixed(4));
  const row = normalizeLog({
    ...entry,
    cost_usd: costUsd,
    cost_zar: costZar,
  });

  try {
    const store = await readStore(COSTS_FILE, { logs: [] });
    const logs = [row, ...(store.logs || [])].slice(0, MAX_LOGS);
    await writeStore(COSTS_FILE, { logs });
  } catch (err) {
    console.warn('logImageGenCost:', err?.message || err);
  }

  await logImageGenCostDb(sb, row);

  maybeSendImageGenBudgetAlerts(sb).catch((err) => {
    console.warn('budget alerts:', err?.message || err);
  });

  return { costUsd, costZar, usdToZar };
}

async function logImageGenCostDb(sb, row) {
  if (!sb) return;
  const baseRow = {
    id: row.id,
    sku: row.sku,
    slot: row.slot,
    operation: row.operation,
    model: row.model,
    image_style: row.image_style,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cost_usd: row.cost_usd,
    cost_zar: row.cost_zar,
    processing_ms: row.processing_ms,
    operator: row.operator,
    batch_id: row.batch_id,
    status: row.status,
    error: row.error,
  };
  try {
    let { error } = await sb.from('image_gen_cost_logs').insert({
      ...baseRow,
      cost_source: row.cost_source,
    });
    if (error && /cost_source/i.test(error.message || '')) {
      ({ error } = await sb.from('image_gen_cost_logs').insert(baseRow));
    }
    if (error && !isMissingTableError(error)) {
      console.warn('logImageGenCostDb:', error.message);
    }
  } catch (err) {
    if (!isMissingTableError(err)) console.warn('logImageGenCostDb:', err?.message || err);
  }
}

function purgeExpiredLocks(locks = []) {
  const now = Date.now();
  return locks.filter((l) => new Date(l.expires_at || l.expiresAt).getTime() > now);
}

export async function purgeExpiredLocksStore() {
  try {
    const result = await mutateStore(LOCKS_FILE, { locks: [] }, (store) => {
      const locks = purgeExpiredLocks(store.locks || []);
      return { store: { locks } };
    });
    return result?.store?.locks ?? [];
  } catch {
    const store = await readStore(LOCKS_FILE, { locks: [] });
    return purgeExpiredLocks(store.locks || []);
  }
}

export async function acquireTransformSemaphore(sb, { batchId, operator, ttlSec = 300 } = {}) {
  const { assertImageGenBudgetAllowsSpend } = await import('./_image-gen-budget.js');
  await assertImageGenBudgetAllowsSpend(sb);

  const db = await acquireTransformSemaphoreDb(sb, { batchId, operator, ttlSec });
  if (db) return db;

  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  try {
    const result = await mutateStore(SEMAPHORE_FILE, { slots: [] }, (store) => {
      const now = Date.now();
      let slots = (store.slots || []).filter((s) => new Date(s.expires_at).getTime() > now);
      const existing = slots.find((s) => s.batch_id === batchId);
      if (existing) return { store: { slots }, acquired: true, reentry: true };
      if (slots.length >= MAX_CONCURRENT_TRANSFORMS) {
        return {
          abort: true,
          conflict: true,
          operator: slots[0]?.operator || 'another user',
        };
      }
      slots.push({
        batch_id: batchId || null,
        operator: operator || null,
        locked_at: new Date().toISOString(),
        expires_at: expiresAt,
      });
      return { store: { slots }, acquired: true };
    });
    if (result?.conflict) {
      throw new Error(`Image generation queue full (${MAX_CONCURRENT_TRANSFORMS} running). ${result.operator || 'Another user'} is processing — try again shortly.`);
    }
    return { acquired: true, reentry: !!result?.reentry };
  } catch (err) {
    if (err?.code === 'IMAGE_GEN_BUDGET_EXCEEDED') throw err;
    if (/queue full/i.test(err.message)) throw err;
    throw new Error(`Could not enter image gen queue — ${err.message || 'try again'}`);
  }
}

export async function releaseTransformSemaphore(_sb, batchId) {
  if (!batchId) return;
  await releaseTransformSemaphoreDb(_sb, batchId);
  try {
    await mutateStore(SEMAPHORE_FILE, { slots: [] }, (store) => {
      const slots = (store.slots || []).filter((s) => s.batch_id !== batchId);
      return { store: { slots } };
    });
  } catch { /* ignore */ }
}

export async function acquireImageGenLock(_sb, { sku, slot, batchId, operator, ttlSec = 180 } = {}) {
  const db = await acquireImageGenLockDb(_sb, { sku, slot, batchId, operator, ttlSec });
  if (db) return db;

  const cleanSku = String(sku || '').trim();
  const cleanSlot = Math.min(4, Math.max(1, Number(slot) || 1));
  if (!cleanSku) throw new Error('Missing SKU for lock');

  const key = `${cleanSku}::${cleanSlot}`;

  try {
    const result = await mutateStore(LOCKS_FILE, { locks: [] }, (store) => {
      const locks = purgeExpiredLocks(store.locks || []);
      const existing = locks.find((l) => `${l.sku}::${l.slot}` === key);

      if (existing) {
        if (existing.batch_id === batchId || existing.batchId === batchId) {
          return { store: { locks }, acquired: true, reentry: true };
        }
        return {
          abort: true,
          conflict: true,
          operator: existing.operator || 'another user',
          sku: cleanSku,
          slot: cleanSlot,
        };
      }

      const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      locks.push({
        sku: cleanSku,
        slot: cleanSlot,
        batch_id: batchId || null,
        operator: operator || null,
        locked_at: new Date().toISOString(),
        expires_at: expiresAt,
      });
      return { store: { locks }, acquired: true };
    });

    if (result?.conflict) {
      const who = result.operator || 'another user';
      throw new Error(`"${cleanSku}" slot ${cleanSlot} is in use by ${who}. Wait for their batch to finish or try again shortly.`);
    }

    return { locked: true, sku: cleanSku, slot: cleanSlot, reentry: !!result?.reentry };
  } catch (err) {
    if (/in use by/i.test(err.message)) throw err;
    throw new Error(`Could not acquire lock for "${cleanSku}" slot ${cleanSlot} — ${err.message || 'try again'}`);
  }
}

export async function releaseImageGenLock(_sb, sku, slot) {
  await releaseImageGenLockDb(_sb, sku, slot);
  try {
    const cleanSku = String(sku || '').trim();
    const cleanSlot = Math.min(4, Math.max(1, Number(slot) || 1));
    await mutateStore(LOCKS_FILE, { locks: [] }, (store) => {
      const locks = (store.locks || []).filter((l) => !(l.sku === cleanSku && Number(l.slot) === cleanSlot));
      return { store: { locks } };
    });
  } catch { /* ignore */ }
}

export async function registerImageGenBatch(_sb, { batchId, operator, total, style, productCount } = {}) {
  if (!batchId) return;
  await registerImageGenBatchDb(_sb, { batchId, operator, total, style, productCount });
  try {
    await mutateStore(BATCHES_FILE, { batches: [] }, (store) => {
      const batches = (store.batches || []).filter((b) => b.id !== batchId);
      batches.unshift({
        id: batchId,
        operator: operator || null,
        status: 'running',
        total: Number(total) || 0,
        done: 0,
        failed: 0,
        style: style || null,
        product_count: Number(productCount) || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return { store: { batches: batches.slice(0, 50) } };
    });
  } catch (err) {
    console.warn('registerImageGenBatch:', err?.message || err);
  }
}

export async function updateImageGenBatch(_sb, batchId, patch = {}) {
  if (!batchId) return;
  await updateImageGenBatchDb(_sb, batchId, patch);
  if (patch.status === 'complete' || patch.status === 'cancelled') {
    await releaseTransformSemaphore(_sb, batchId);
  }
  try {
    await mutateStore(BATCHES_FILE, { batches: [] }, (store) => {
      const batches = (store.batches || []).map((b) => {
        if (b.id !== batchId) return b;
        const next = {
          ...b,
          ...patch,
          updated_at: new Date().toISOString(),
        };
        if (patch.status === 'complete' || patch.status === 'cancelled') {
          next.finished_at = new Date().toISOString();
        }
        return next;
      });
      return { store: { batches } };
    });
  } catch { /* ignore */ }
}

export async function listImageGenCosts(sb, { days = 30, limit = 200 } = {}) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(since).toISOString();
  const cap = Math.min(limit, 500);

  if (sb) {
    try {
      const { data, error } = await sb
        .from('image_gen_cost_logs')
        .select('*')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(cap);
      if (!error && data) {
        return data.map((r) => normalizeLog({
          id: r.id,
          created_at: r.created_at,
          sku: r.sku,
          slot: r.slot,
          operation: r.operation,
          model: r.model,
          image_style: r.image_style,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          cost_usd: r.cost_usd,
          cost_zar: r.cost_zar,
          cost_source: r.cost_source,
          processing_ms: r.processing_ms,
          operator: r.operator,
          batch_id: r.batch_id,
          status: r.status,
          error: r.error,
        }));
      }
      if (error && !isMissingTableError(error)) {
        console.warn('listImageGenCosts db:', error.message);
      }
    } catch (err) {
      if (!isMissingTableError(err)) console.warn('listImageGenCosts db:', err?.message || err);
    }
  }

  const store = await readStore(COSTS_FILE, { logs: [] });
  return (store.logs || [])
    .map(normalizeLog)
    .filter((row) => new Date(row.created_at).getTime() >= since)
    .slice(0, cap);
}

export async function listActiveImageGenState(_sb) {
  const dbState = await listActiveImageGenStateDb(_sb);
  if (dbState) return dbState;

  const locks = await purgeExpiredLocksStore();
  const store = await readStore(BATCHES_FILE, { batches: [] });
  const batches = (store.batches || []).filter((b) => b.status === 'running');
  return { locks, batches };
}

export function summarizeCosts(logs = []) {
  const totals = { usd: 0, zar: 0, count: 0, errors: 0 };
  const byDay = new Map();
  const byOperator = new Map();
  const byOperation = new Map();
  const byCostSource = new Map();

  for (const row of logs.map(normalizeLog)) {
    const usd = Number(row.cost_usd) || 0;
    const zar = Number(row.cost_zar) || 0;
    totals.usd += usd;
    totals.zar += zar;
    totals.count += 1;
    if (row.status === 'error') totals.errors += 1;

    const day = String(row.created_at || '').slice(0, 10);
    if (day) {
      const d = byDay.get(day) || { usd: 0, zar: 0, count: 0 };
      d.usd += usd;
      d.zar += zar;
      d.count += 1;
      byDay.set(day, d);
    }

    const op = row.operator || 'Unknown';
    const o = byOperator.get(op) || { usd: 0, zar: 0, count: 0 };
    o.usd += usd;
    o.zar += zar;
    o.count += 1;
    byOperator.set(op, o);

    const kind = row.operation || 'other';
    const k = byOperation.get(kind) || { usd: 0, zar: 0, count: 0 };
    k.usd += usd;
    k.zar += zar;
    k.count += 1;
    byOperation.set(kind, k);

    const src = row.cost_source || 'estimated';
    const s = byCostSource.get(src) || { usd: 0, zar: 0, count: 0 };
    s.usd += usd;
    s.zar += zar;
    s.count += 1;
    byCostSource.set(src, s);
  }

  return {
    totals,
    byDay: [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, v]) => ({ day, ...v })),
    byOperator: [...byOperator.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([operator, v]) => ({ operator, ...v })),
    byOperation: [...byOperation.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([operation, v]) => ({ operation, ...v })),
    byCostSource: [...byCostSource.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([costSource, v]) => ({ costSource, ...v })),
  };
}
