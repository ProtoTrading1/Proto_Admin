import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('Instore image-only archive contract', () => {
  it('uses an owner-only route and changes only a private image control record', () => {
    const route = readFileSync(join(ROOT, 'api/instore-image-controls.js'), 'utf8');
    expect(route).toContain('requireOwner(req, res)');
    expect(route).toContain("from('extended_range_items')");
    expect(route).toContain("rpc('set_instore_image_control'");
    expect(route).not.toContain("from('extended_range_items').update");
    expect(route).not.toContain("from('website_stock').update");
  });

  it('keeps the controls and history service-role-only with an atomic audit RPC', () => {
    const migration = readFileSync(join(ROOT, 'migrations/068_instore_image_controls.sql'), 'utf8');
    expect(migration).toContain('create table if not exists public.instore_image_controls');
    expect(migration).toContain('create table if not exists public.instore_image_control_events');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on public.instore_image_controls from anon, authenticated');
    expect(migration).toContain('grant all on public.instore_image_controls to service_role');
    expect(migration).toContain('security invoker');
    expect(migration).toContain('insert into public.instore_image_control_events');
  });

  it('makes the owner workflow explicit about preserving the sellable SKU', () => {
    const panel = readFileSync(join(ROOT, 'src/components/productLoader/InstoreImageControlPanel.jsx'), 'utf8');
    expect(panel).toContain('Hide a wrong photo without archiving the product');
    expect(panel).toContain('Product, price and stock are unchanged.');
    expect(panel).toContain("action === 'hide'");
    expect(panel).toContain("action === 'restore'");
  });
});
