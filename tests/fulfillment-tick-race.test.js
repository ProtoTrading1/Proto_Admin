import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../src/pages/FulfillmentPage.jsx', import.meta.url), 'utf8');

/**
 * The stock-check tick used to untick itself. A poll that STARTED while a tick
 * was in flight carries pre-tick state; the tick's own response deletes its
 * pending-overlay entry, so by the time that poll resolves there is nothing
 * left to overlay it with. The staleness guard compared the poll's start time
 * against the tick's START time, which is earlier than the poll's — so the
 * guard did not fire and the stale snapshot reached the screen.
 *
 * The fix is to move the watermark to the tick's RESPONSE time, on both the
 * success and the failure path.
 */
describe('fulfilment tick cannot be reverted by an in-flight poll', () => {
  it('bumps the staleness watermark when the tick resolves, not only when it starts', () => {
    // Once before the request, once on success, once on failure.
    const bumps = source.match(/lastTickAtRef\.current = Date\.now\(\)/g) || [];
    expect(bumps.length).toBeGreaterThanOrEqual(3);
  });

  it('discards a snapshot that predates the newest tick', () => {
    expect(source).toMatch(/if \(lastTickAtRef\.current > startedAt\) return;/);
  });

  it('overlays unconfirmed ticks onto every server snapshot', () => {
    expect(source).toMatch(/setProgress\(overlayPendingTicks\(data\)\)/);
  });

  it('bumps the watermark before dropping the pending entry', () => {
    // Order matters: dropping the entry first reopens the window this closes.
    const success = source.slice(source.indexOf('const data = await toggleFulfillmentItem'));
    const bump = success.indexOf('lastTickAtRef.current = Date.now()');
    const drop = success.indexOf('pendingTicksRef.current.delete(key)');
    expect(bump).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(-1);
    expect(bump).toBeLessThan(drop);
  });
});
