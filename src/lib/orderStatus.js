export const WORKFLOW_STATUSES = [
  'pending',
  'handed over',
  'order in progress',
  'order sent',
  'payment received',
];

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

export const WORKFLOW_META = {
  pending: { label: 'New', color: '#64748b', bg: '#f1f5f9', step: 0 },
  'handed over': { label: 'Handed Over', color: '#2563eb', bg: '#dbeafe', step: 1 },
  'order in progress': { label: 'Order In Progress', color: '#d97706', bg: '#fef3c7', step: 2 },
  'order sent': { label: 'Order Confirmation', color: '#16a34a', bg: '#dcfce7', step: 3 },
  'payment received': { label: 'Payment Received', color: '#15803d', bg: '#bbf7d0', step: 4 },
};

export function getWorkflowMeta(status) {
  const key = normalizeOrderStatus(status);
  return WORKFLOW_META[key] || WORKFLOW_META.pending;
}

export function getStatusTimestamp(order, status) {
  const key = normalizeOrderStatus(status);
  if (key === 'handed over') return order?.handed_over_at;
  if (key === 'order in progress') return order?.order_in_progress_at;
  if (key === 'order sent') return order?.order_sent_at;
  if (key === 'payment received') return order?.payment_received_at;
  return null;
}

export function getNextManualStatus(status) {
  const key = normalizeOrderStatus(status);
  if (key === 'order in progress') return 'order sent';
  if (key === 'order sent') return 'payment received';
  return null;
}

export function getWorkflowAdvanceOptions(status) {
  const key = normalizeOrderStatus(status);
  if (key === 'pending') return [{ label: 'Mark handed over', target: 'handed over' }];
  if (key === 'handed over') return [{ label: 'Start fulfilment', target: 'order in progress' }];
  if (key === 'order in progress') return [{ label: 'Move to order confirmation', target: 'order sent' }];
  if (key === 'order sent') return [{ label: 'Mark payment received', target: 'payment received' }];
  return [];
}

export function isNewOrderStatus(status) {
  return workflowStageIndex(status) === 0;
}

export function isOrderConfirmationSent(order, confirmationSentIds = null) {
  if (order?.confirmation_sent_at) return true;
  return confirmationSentIds?.has?.(String(order?.id)) ?? false;
}

export function orderMatchesTab(order, tab, { confirmationSentIds = null } = {}) {
  const key = normalizeOrderStatus(order?.status);
  const sent = isOrderConfirmationSent(order, confirmationSentIds);
  if (tab === 'new') return key === 'pending';
  if (tab === 'handed') return key === 'handed over';
  if (tab === 'progress') return key === 'order in progress';
  if (tab === 'sent') return key === 'order sent' && !sent;
  if (tab === 'paid') return key === 'payment received' || (key === 'order sent' && sent);
  return true;
}
