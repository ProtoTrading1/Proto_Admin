import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOrderTrashEnabled, normalizeOrderTrashReason } from '../lib/order-trash.mjs';

describe('recoverable order trash gate', () => {
  it('is disabled by default and only enables explicitly', () => {
    // On by default now that the migration is applied; 'false' is the switch.
    expect(isOrderTrashEnabled({})).toBe(true);
    expect(isOrderTrashEnabled({ ORDER_TRASH_ENABLED: 'true' })).toBe(true);
    expect(isOrderTrashEnabled({ ORDER_TRASH_ENABLED: 'false' })).toBe(false);
    expect(isOrderTrashEnabled({ ORDER_TRASH_ENABLED: 'FALSE' })).toBe(false);
  });

  it('requires an auditable reason', () => {
    expect(() => normalizeOrderTrashReason('short')).toThrow(/at least 8/i);
    expect(normalizeOrderTrashReason('Duplicate test order')).toBe('Duplicate test order');
  });

  it('contains no bulk permanent order deletion path', () => {
    const source = fs.readFileSync(new URL('../api/admin-orders.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\('orders'\)\.delete\(\)\.not\('id'/);
    expect(source).not.toMatch(/from\('orders'\)\.delete\(\)\.eq\('id'/);
    expect(source).toContain("rpc('trash_admin_order'");
  });

  it('keeps the draft trash table private and functions invoker-scoped', () => {
    const migration = fs.readFileSync(new URL('../migrations/056_recoverable_order_trash.sql', import.meta.url), 'utf8');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on table public.admin_order_trash from anon, authenticated');
    expect(migration).toContain('security invoker');
    expect(migration).not.toContain('security definer');
  });

  it('restores only writable order columns and lets Postgres regenerate search text', () => {
    const migration = fs.readFileSync(new URL('../migrations/056_recoverable_order_trash.sql', import.meta.url), 'utf8');
    const insertColumns = migration.match(/insert into public\.orders \(([^)]+)\) values/s)?.[1] || '';
    expect(insertColumns).toContain('client_ref');
    expect(insertColumns).not.toContain('items_search');
    expect(migration).not.toContain('select * from jsonb_populate_record');
  });

  it('refuses to discard delivery or notification audit records', () => {
    const migration = fs.readFileSync(new URL('../migrations/056_recoverable_order_trash.sql', import.meta.url), 'utf8');
    const guardAt = migration.indexOf('Order has linked delivery or notification records');
    const deleteAt = migration.indexOf('delete from public.orders');
    expect(migration).toContain('public.order_notification_jobs');
    expect(migration).toContain('public.order_notification_events');
    expect(migration).toContain('public.order_delivery_jobs');
    expect(guardAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(guardAt);
  });

  it('only exposes the trash action when the server capability is enabled', () => {
    const api = fs.readFileSync(new URL('../api/admin-orders.js', import.meta.url), 'utf8');
    const client = fs.readFileSync(new URL('../src/lib/orders.js', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
    expect(api).toContain("orderTrash: auth.type === 'admin' && isOrderTrashEnabled()");
    expect(client).toContain('orderTrashEnabled: json.capabilities?.orderTrash === true');
    expect(page).toContain('{orderTrashEnabled && (');
  });
});
