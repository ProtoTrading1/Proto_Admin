/** Four-stage order workflow — keep in sync with protoportal-main/api/_order-status.js */

export const WORKFLOW_STATUSES = [
  'pending',
  'handed over',
  'order in progress',
  'order sent',
  'payment received',
];

const TIMESTAMP_COLUMNS = {
  'handed over': 'handed_over_at',
  'order in progress': 'order_in_progress_at',
  'order sent': 'order_sent_at',
  'payment received': 'payment_received_at',
};

const LEGACY_STATUS_MAP = {
  viewed: 'pending',
  'awaiting payment': 'order in progress',
  paid: 'payment received',
  delivered: 'order sent',
};

export function normalizeOrderStatus(raw) {
  const key = String(raw || 'pending').trim().toLowerCase();
  if (LEGACY_STATUS_MAP[key]) return LEGACY_STATUS_MAP[key];
  if (WORKFLOW_STATUSES.includes(key)) return key;
  return 'pending';
}

export function workflowStageIndex(status) {
  const normalized = normalizeOrderStatus(status);
  const idx = WORKFLOW_STATUSES.indexOf(normalized);
  return idx >= 0 ? idx : 0;
}

export function canAdvanceTo(currentStatus, nextStatus) {
  const current = workflowStageIndex(currentStatus);
  const next = workflowStageIndex(nextStatus);
  if (next <= current) return false;
  return next === current + 1;
}

export async function advanceOrderStatus(supabase, orderId, nextStatus, { force = false } = {}) {
  const target = normalizeOrderStatus(nextStatus);
  if (!WORKFLOW_STATUSES.includes(target) || target === 'pending') {
    return { ok: false, reason: 'invalid-status' };
  }

  const { data: order, error: loadErr } = await supabase
    .from('orders')
    .select('id, status')
    .eq('id', orderId)
    .maybeSingle();

  if (loadErr) throw loadErr;
  if (!order) return { ok: false, reason: 'not-found' };

  const current = normalizeOrderStatus(order.status);
  if (!force && !canAdvanceTo(current, target)) {
    return { ok: false, reason: 'sequential-only', current, target };
  }

  const now = new Date().toISOString();
  const patch = { status: target };
  const tsCol = TIMESTAMP_COLUMNS[target];
  if (tsCol) patch[tsCol] = now;
  if (target === 'payment received') patch.paid_at = now;

  const { data, error } = await supabase
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .select('id, status, handed_over_at, order_in_progress_at, order_sent_at, payment_received_at')
    .single();

  if (error) throw error;
  return { ok: true, order: data, previous: current };
}

/** Advance through each workflow stage until the target is reached (or already past it). */
export async function advanceOrderStatusToTarget(supabase, orderId, nextStatus, { force = false } = {}) {
  const target = normalizeOrderStatus(nextStatus);
  if (!WORKFLOW_STATUSES.includes(target) || target === 'pending') {
    return { ok: false, reason: 'invalid-status' };
  }

  let lastResult = null;
  let guard = 0;
  while (guard < WORKFLOW_STATUSES.length) {
    guard += 1;
    const { data: order, error: loadErr } = await supabase
      .from('orders')
      .select('id, status')
      .eq('id', orderId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!order) return { ok: false, reason: 'not-found' };

    const current = normalizeOrderStatus(order.status);
    if (workflowStageIndex(current) >= workflowStageIndex(target)) {
      return lastResult || { ok: true, order, previous: current, alreadyAtOrPast: true };
    }

    const nextIdx = workflowStageIndex(current) + 1;
    const stepTarget = WORKFLOW_STATUSES[nextIdx];
    if (!stepTarget) return { ok: false, reason: 'invalid-step', current, target };

    lastResult = await advanceOrderStatus(supabase, orderId, stepTarget, { force });
    if (!lastResult.ok) return lastResult;
    if (stepTarget === target) return lastResult;
  }

  return lastResult || { ok: false, reason: 'max-steps' };
}
