import { describe, expect, it } from 'vitest';
import {
  catalogueState,
  freshnessState,
  queueState,
  worstState,
} from '../lib/backend-health.mjs';

describe('backend health evaluation', () => {
  it('makes a critical check the overall state', () => {
    expect(worstState([
      { state: 'healthy' },
      { state: 'warning' },
      { state: 'critical' },
      { state: 'disabled' },
    ])).toBe('critical');
  });

  it('reports an intentionally disabled queue without a false failure', () => {
    expect(queueState({ enabled: false, failed: 7 })).toMatchObject({
      state: 'disabled',
    });
  });

  it('flags dead-letter notification jobs as critical', () => {
    expect(queueState({ enabled: true, failed: 1 })).toMatchObject({
      state: 'critical',
    });
  });

  it('uses warning and critical freshness thresholds', () => {
    const now = new Date('2026-07-29T12:00:00Z').getTime();
    expect(freshnessState('2026-07-29T10:00:00Z', {
      warningAfterHours: 6,
      criticalAfterHours: 24,
      now,
    }).state).toBe('healthy');
    expect(freshnessState('2026-07-29T04:00:00Z', {
      warningAfterHours: 6,
      criticalAfterHours: 24,
      now,
    }).state).toBe('warning');
    expect(freshnessState('2026-07-27T04:00:00Z', {
      warningAfterHours: 6,
      criticalAfterHours: 24,
      now,
    }).state).toBe('critical');
  });

  it('makes unsafe prices critical and stock differences warnings', () => {
    expect(catalogueState({ invalidPrices: 1 }).state).toBe('critical');
    expect(catalogueState({ majorStockMismatch: 2 }).state).toBe('warning');
    expect(catalogueState({}).state).toBe('healthy');
  });
});
