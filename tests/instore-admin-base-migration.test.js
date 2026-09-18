import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const migration = readFileSync(join(ROOT, 'migrations/069a_instore_admin_base.sql'), 'utf8');

describe('Instore admin base migration contract', () => {
  it('keeps the private review queue and immutable audit trail in source control', () => {
    expect(migration).toContain('create table if not exists public.instore_admin_items');
    expect(migration).toContain('create table if not exists public.instore_admin_item_events');
    expect(migration).toContain("check (status in ('archived', 'live', 'recycle'))");
    expect(migration).toContain("check (availability_mode in ('positill', 'stock_available', 'to_order'))");
    expect(migration).toContain('create index if not exists instore_admin_status_updated');
    expect(migration).toContain('create index if not exists instore_admin_events_sku');
  });

  it('makes intake storage private and keeps browser roles out of the queue', () => {
    expect(migration).toContain("'instore-intake'");
    expect(migration).toContain('false,');
    expect(migration).toContain('2097152');
    expect(migration).toContain('alter table public.instore_admin_items enable row level security');
    expect(migration).toContain('revoke all on public.instore_admin_items from anon, authenticated');
    expect(migration).toContain('revoke all on public.instore_admin_item_events from anon, authenticated');
    expect(migration).toContain('grant select, insert, update on public.instore_admin_items to service_role');
  });

  it('uses an optimistic, serialized, fail-closed transition RPC', () => {
    expect(migration).toContain('create or replace function public.instore_admin_transition');
    expect(migration).toContain('security invoker');
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("raise exception 'stale_version'");
    expect(migration).toContain("raise exception 'Instore publish integration pending'");
    expect(migration).toContain('insert into public.instore_admin_item_events');
    expect(migration).toContain('revoke all on function public.instore_admin_transition');
  });
});
