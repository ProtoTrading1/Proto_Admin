export const HEALTH_LEVELS = Object.freeze({
  healthy: 0,
  disabled: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
});

export function ageHours(value, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now - timestamp) / 3_600_000);
}

export function freshnessState(value, {
  warningAfterHours,
  criticalAfterHours,
  now = Date.now(),
} = {}) {
  const hours = ageHours(value, now);
  if (hours == null) return { state: 'unknown', ageHours: null };
  if (hours >= criticalAfterHours) return { state: 'critical', ageHours: hours };
  if (hours >= warningAfterHours) return { state: 'warning', ageHours: hours };
  return { state: 'healthy', ageHours: hours };
}

export function worstState(checks) {
  return checks.reduce((worst, check) => (
    (HEALTH_LEVELS[check?.state] ?? HEALTH_LEVELS.unknown)
      > (HEALTH_LEVELS[worst] ?? HEALTH_LEVELS.unknown)
      ? check.state
      : worst
  ), 'healthy');
}

export function queueState({ enabled, failed = 0, overdue = 0, processing = 0, heartbeatAt = null }, now = Date.now()) {
  if (!enabled) return { state: 'disabled', reason: 'Queue is installed but intentionally disabled.' };
  if (failed > 0) return { state: 'critical', reason: `${failed} notification job${failed === 1 ? '' : 's'} need attention.` };
  if (overdue > 0) return { state: 'warning', reason: `${overdue} notification job${overdue === 1 ? '' : 's'} are overdue.` };
  if (processing > 0 && ageHours(heartbeatAt, now) > 0.5) {
    return { state: 'critical', reason: 'Jobs are processing but the worker heartbeat is stale.' };
  }
  if (!heartbeatAt) return { state: 'warning', reason: 'Queue is enabled but no worker heartbeat has been recorded.' };
  return { state: 'healthy', reason: 'Notification worker is current and no jobs need attention.' };
}

export function catalogueState({ invalidPrices = 0, doubleVat = 0, majorPriceMismatch = 0, majorStockMismatch = 0 }) {
  const pricingFailures = invalidPrices + doubleVat + majorPriceMismatch;
  if (pricingFailures > 0) {
    return {
      state: 'critical',
      reason: `${pricingFailures} live product${pricingFailures === 1 ? '' : 's'} have unsafe pricing.`,
    };
  }
  if (majorStockMismatch > 0) {
    return {
      state: 'warning',
      reason: `${majorStockMismatch} live product${majorStockMismatch === 1 ? '' : 's'} have a major stock difference.`,
    };
  }
  return { state: 'healthy', reason: 'No unsafe live catalogue prices were detected.' };
}
