import { describe, expect, it } from 'vitest';
import {
  advanceOrderStatusToTarget,
  normalizeOrderStatus,
  WORKFLOW_STATUSES,
} from '../api/_order-status.js';
import { orderMatchesTab } from '../src/lib/orderStatus.js';

/**
 * "Mark as completed" advances an order to `payment received` from wherever it
 * is, so it leaves the working tabs and lands in Payment. These lock in the two
 * halves of that promise: the walk reaches the target, and the target is the
 * only status the Payment tab holds on its own.
 */

/** Minimal Supabase double: one orders row, patched in place. */
function fakeSupabase(initialStatus) {
  const row = { id: 'order-1', status: initialStatus };
  const updates = [];

  return {
    row,
    updates,
    from() {
      const builder = {
        _patch: null,
        select() { return builder; },
        update(patch) { builder._patch = patch; return builder; },
        eq() { return builder; },
        async maybeSingle() { return { data: { ...row }, error: null }; },
        async single() {
          Object.assign(row, builder._patch);
          updates.push({ ...builder._patch });
          return { data: { ...row }, error: null };
        },
      };
      return builder;
    },
  };
}

const STARTING_POINTS = WORKFLOW_STATUSES.filter((s) => s !== 'payment received');

describe('mark as completed → Payment tab', () => {
  it.each(STARTING_POINTS)('walks an order at "%s" through to payment received', async (start) => {
    const supabase = fakeSupabase(start);

    const result = await advanceOrderStatusToTarget(supabase, 'order-1', 'payment received');

    expect(result.ok).toBe(true);
    expect(supabase.row.status).toBe('payment received');
  });

  it('steps through every intermediate stage rather than skipping them', async () => {
    const supabase = fakeSupabase('pending');

    await advanceOrderStatusToTarget(supabase, 'order-1', 'payment received');

    // pending → handed over → order in progress → order sent → payment received
    expect(supabase.updates.map((u) => u.status)).toEqual([
      'handed over',
      'order in progress',
      'order sent',
      'payment received',
    ]);
  });

  it('stamps the payment timestamps the Payment tab reads', async () => {
    const supabase = fakeSupabase('order sent');

    await advanceOrderStatusToTarget(supabase, 'order-1', 'payment received');

    const last = supabase.updates.at(-1);
    expect(last.payment_received_at).toBeTruthy();
    expect(last.paid_at).toBeTruthy();
  });

  it('is a no-op for an order already at payment received', async () => {
    const supabase = fakeSupabase('payment received');

    const result = await advanceOrderStatusToTarget(supabase, 'order-1', 'payment received');

    expect(result.ok).toBe(true);
    expect(supabase.updates).toHaveLength(0);
  });

  it('lands the order in Payment and no other tab', () => {
    const completed = { status: 'payment received' };
    const confirmationSentIds = new Set();

    expect(orderMatchesTab(completed, 'paid', { confirmationSentIds })).toBe(true);
    ['new', 'handed', 'progress', 'sent'].forEach((tab) => {
      expect(orderMatchesTab(completed, tab, { confirmationSentIds })).toBe(false);
    });
  });

  it('treats the legacy "paid" status as completed too, so old orders do not reappear', () => {
    expect(normalizeOrderStatus('paid')).toBe('payment received');
    expect(orderMatchesTab({ status: 'paid' }, 'paid', { confirmationSentIds: new Set() })).toBe(true);
  });
});
