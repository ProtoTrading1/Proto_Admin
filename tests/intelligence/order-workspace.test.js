import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertValidTransition,
  customerSnapshot,
  isOverdueDate,
  parseOrderCommand,
  resolveCustomerMatch,
  workspaceDeadlines,
} from '../../api/_order-workspace-core.js';

describe('Orders Workspace v1 — command and state model', () => {
  it('parses /order commands without treating them as chat', () => {
    expect(parseOrderCommand('/order Addie')).toEqual({
      command: '/order Addie',
      customerQuery: 'Addie',
    });
    expect(parseOrderCommand('order Addie')).toBeNull();
  });

  it('preserves a customer snapshot for durable workspace memory', () => {
    expect(customerSnapshot({
      id: 'cust-1',
      business_name: 'Addie Gifts',
      name: 'Addie',
      contact_name: 'Addie Smith',
      email: 'addie@example.com',
      phone: '0821234567',
      customer_code: 'ADD001',
    })).toMatchObject({
      customerId: 'cust-1',
      customerName: 'Addie Gifts',
      account: 'ADD001',
      contact: 'Addie Smith',
      email: 'addie@example.com',
      phone: '0821234567',
    });
  });

  it('asks for customer disambiguation instead of choosing weak multi-matches', () => {
    const matches = [
      { id: '1', business_name: 'Addie Gifts', email: 'a@example.com' },
      { id: '2', business_name: 'Addie Wholesale', email: 'b@example.com' },
    ];
    expect(resolveCustomerMatch(matches, 'Addie')).toMatchObject({
      ambiguous: true,
      matches,
    });
    expect(resolveCustomerMatch(matches, 'Addie Gifts')).toMatchObject({
      ambiguous: false,
      customer: matches[0],
    });
  });

  it('accepts only frozen-spec state transitions', () => {
    expect(assertValidTransition('Draft', 'Pending Review')).toBe('Pending Review');
    expect(assertValidTransition('Quoted', 'Waiting Supplier')).toBe('Waiting Supplier');
    expect(() => assertValidTransition('Draft', 'Delivered')).toThrow(/Invalid order workspace transition/);
    expect(() => assertValidTransition('Closed', 'Draft')).toThrow(/Invalid order workspace transition/);
  });

  it('calculates overdue promises and reminders for Daily Brief integration', () => {
    const now = new Date('2026-07-10T12:00:00.000Z');
    expect(isOverdueDate('2026-07-09', now)).toBe(true);
    const deadlines = workspaceDeadlines({
      tasks: [{ status: 'Open', due_date: '2026-07-09' }, { status: 'Completed', due_date: '2026-07-01' }],
      promises: [{ status: 'Open', due_date: '2026-07-08' }],
      reminders: [{ status: 'Open', due_date: '2026-07-11' }],
    }, now);
    expect(deadlines.overdueTasks).toHaveLength(1);
    expect(deadlines.overduePromises).toHaveLength(1);
    expect(deadlines.overdueReminders).toHaveLength(0);
  });
});

describe('Orders Workspace v1 — API and audit contract', () => {
  it('keeps the API admin-authenticated', () => {
    const source = readFileSync('api/order-workspaces.js', 'utf8');
    expect(source).toMatch(/requireAdminKey/);
  });

  it('creates timeline rows for every supported mutation action', () => {
    const source = readFileSync('api/order-workspaces.js', 'utf8');
    for (const event of [
      'order_created',
      'workspace_updated',
      'status_changed',
      'line_added',
      'line_confirmed',
      'task_created',
      'task_completed',
      'promise_recorded',
      'reminder_created',
    ]) {
      expect(source).toContain(event);
    }
  });

  it('protects timeline history from updates and deletes in the migration', () => {
    const sql = readFileSync('migrations/044_order_workspaces_v1.sql', 'utf8');
    expect(sql).toMatch(/order_workspace_timeline/i);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.order_workspace_timeline/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'order workspace timeline is append-only'/i);
  });
});

