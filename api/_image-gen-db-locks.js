/**
 * Postgres-backed image gen locks (migration 019) — atomic across Vercel instances.
 * Falls back silently when tables are missing or PostgREST schema cache is stale.
 */

import { MAX_CONCURRENT_TRANSFORMS } from './_image-gen-constants.js';

const DEFAULT_LOCK_TTL_SEC = 180;
const DEFAULT_SEM_TTL_SEC = 300;
const MAX_CONCURRENT_BATCHES = MAX_CONCURRENT_TRANSFORMS;

export function isMissingTableError(err) {
  if (!err) return false;
  const msg = String(err.message || err || '').toLowerCase();
  const code = String(err.code || '');
  return (
    code === '42P01'
    || code === 'PGRST205'
    || code === 'PGRST204'
    || msg.includes('could not find the table')
    || msg.includes('schema cache')
    || msg.includes('does not exist')
    || (msg.includes('column') && msg.includes('does not exist'))
  );
}

async function purgeExpiredLocks(sb) {
  const { error } = await sb.from('image_gen_locks').delete().lt('expires_at', new Date().toISOString());
  if (error && !isMissingTableError(error)) {
    console.warn('purgeExpiredLocks:', error.message);
  }
}

export async function acquireImageGenLockDb(sb, { sku, slot, batchId, operator, ttlSec = DEFAULT_LOCK_TTL_SEC } = {}) {
  const cleanSku = String(sku || '').trim();
  const cleanSlot = Math.min(4, Math.max(1, Number(slot) || 1));
  if (!cleanSku) throw new Error('Missing SKU for lock');

  await purgeExpiredLocks(sb);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  const { data: existing, error: readErr } = await sb
    .from('image_gen_locks')
    .select('*')
    .eq('sku', cleanSku)
    .eq('slot', cleanSlot)
    .maybeSingle();

  if (readErr) {
    if (isMissingTableError(readErr)) return null;
    throw readErr;
  }

  if (existing) {
    if (existing.batch_id === batchId) return { locked: true, reentry: true };
    const who = existing.operator || 'another user';
    throw new Error(`"${cleanSku}" slot ${cleanSlot} is in use by ${who}. Wait for their batch to finish or try again shortly.`);
  }

  const { error: insErr } = await sb.from('image_gen_locks').insert({
    sku: cleanSku,
    slot: cleanSlot,
    batch_id: batchId || null,
    operator: operator || null,
    expires_at: expiresAt,
  });

  if (insErr) {
    if (isMissingTableError(insErr)) return null;
    if (insErr.code === '23505') {
      throw new Error(`"${cleanSku}" slot ${cleanSlot} is in use by another user — try again shortly.`);
    }
    throw insErr;
  }

  return { locked: true, reentry: false };
}

export async function releaseImageGenLockDb(sb, sku, slot) {
  try {
    const cleanSku = String(sku || '').trim();
    const cleanSlot = Math.min(4, Math.max(1, Number(slot) || 1));
    const { error } = await sb.from('image_gen_locks').delete().eq('sku', cleanSku).eq('slot', cleanSlot);
    if (error && !isMissingTableError(error)) console.warn('releaseImageGenLockDb:', error.message);
  } catch { /* ignore */ }
}

export async function acquireTransformSemaphoreDb(sb, { batchId, operator, ttlSec = DEFAULT_SEM_TTL_SEC } = {}) {
  await purgeExpiredLocks(sb);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const staleCutoff = new Date(Date.now() - ttlSec * 1000).toISOString();

  const { data: running, error: listErr } = await sb
    .from('image_gen_batches')
    .select('id, operator, updated_at')
    .eq('status', 'running')
    .gt('updated_at', staleCutoff);

  if (listErr) {
    if (isMissingTableError(listErr)) return null;
    throw listErr;
  }

  if (batchId && (running || []).some((r) => r.id === batchId)) {
    const { error: touchErr } = await sb.from('image_gen_batches').update({ updated_at: new Date().toISOString() }).eq('id', batchId);
    if (touchErr && !isMissingTableError(touchErr)) console.warn('acquireTransformSemaphoreDb touch:', touchErr.message);
    return { acquired: true, reentry: true };
  }

  if ((running || []).length >= MAX_CONCURRENT_BATCHES) {
    const who = running?.[0]?.operator || 'another user';
    throw new Error(`Image generation queue full (${MAX_CONCURRENT_BATCHES} batches running). ${who} is processing — try again shortly.`);
  }

  const { error: upsertErr } = await sb.from('image_gen_batches').upsert({
    id: batchId,
    operator: operator || null,
    status: 'running',
    updated_at: new Date().toISOString(),
    finished_at: null,
  }, { onConflict: 'id' });

  if (upsertErr) {
    if (isMissingTableError(upsertErr)) return null;
    throw upsertErr;
  }

  return { acquired: true, reentry: false, expiresAt };
}

export async function releaseTransformSemaphoreDb(sb, batchId) {
  if (!batchId) return;
  try {
    const { error } = await sb.from('image_gen_batches').update({
      status: 'complete',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', batchId);
    if (error && !isMissingTableError(error)) console.warn('releaseTransformSemaphoreDb:', error.message);
  } catch { /* ignore */ }
}

export async function registerImageGenBatchDb(sb, { batchId, operator, total, style, productCount } = {}) {
  if (!batchId) return;
  try {
    const { error } = await sb.from('image_gen_batches').upsert({
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
    }, { onConflict: 'id' });
    if (error && !isMissingTableError(error)) console.warn('registerImageGenBatchDb:', error.message);
  } catch { /* ignore */ }
}

export async function updateImageGenBatchDb(sb, batchId, patch = {}) {
  if (!batchId) return;
  try {
    const row = {
      ...patch,
      updated_at: new Date().toISOString(),
    };
    if (patch.status === 'complete' || patch.status === 'cancelled') {
      row.finished_at = new Date().toISOString();
    }
    const { error } = await sb.from('image_gen_batches').update(row).eq('id', batchId);
    if (error && !isMissingTableError(error)) console.warn('updateImageGenBatchDb:', error.message);
  } catch { /* ignore */ }
}

export async function listActiveImageGenStateDb(sb) {
  try {
    await purgeExpiredLocks(sb);
    const { data: locks, error: locksErr } = await sb
      .from('image_gen_locks')
      .select('sku, slot, batch_id, operator, expires_at')
      .gt('expires_at', new Date().toISOString());
    if (locksErr) {
      if (isMissingTableError(locksErr)) return null;
      throw locksErr;
    }
    const { data: batches, error: batchesErr } = await sb
      .from('image_gen_batches')
      .select('*')
      .eq('status', 'running')
      .order('updated_at', { ascending: false })
      .limit(20);
    if (batchesErr) {
      if (isMissingTableError(batchesErr)) return null;
      throw batchesErr;
    }
    return { locks: locks || [], batches: batches || [] };
  } catch (err) {
    if (isMissingTableError(err)) return null;
    return null;
  }
}
