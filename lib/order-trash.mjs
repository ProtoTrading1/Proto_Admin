/**
 * Recoverable order trash is ON by default now that migration 056 (+057) is
 * applied in production. It was fail-closed while the database side did not
 * exist — leaving it that way just meant the button was invisible and the
 * feature unusable without a config change nobody knew to make.
 *
 * ORDER_TRASH_ENABLED=false is the kill switch. Note this is a deliberate
 * inversion: UNSETTING the variable no longer disables the feature, so the
 * rollback in docs/ORDER_TRASH_ROLLOUT.md sets it to false explicitly.
 */
export function isOrderTrashEnabled(env = globalThis.process?.env || {}) {
  return String(env.ORDER_TRASH_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

export function normalizeOrderTrashReason(value) {
  const reason = String(value || '').trim();
  if (reason.length < 8) throw new Error('Provide a deletion reason of at least 8 characters.');
  if (reason.length > 500) throw new Error('Deletion reason must be 500 characters or fewer.');
  return reason;
}
