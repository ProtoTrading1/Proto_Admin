import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('Instore image slot staging contract', () => {
  const migration = readFileSync(join(ROOT, 'migrations/070_instore_admin_image_slots.sql'), 'utf8');
  const route = readFileSync(join(ROOT, 'api/instore-admin.js'), 'utf8');

  it('keeps extra source images in a private, source-controlled slot table', () => {
    expect(migration).toContain('create table if not exists public.instore_admin_item_images');
    expect(migration).toContain('primary key (sku, image_slot)');
    expect(migration).toContain('unique (sku, image_slot, content_digest)');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on public.instore_admin_item_images from anon, authenticated');
  });

  it('never silently accepts a second slot as an SKU-level retry', () => {
    expect(route).toContain("const IMAGE_TABLE = 'instore_admin_item_images'");
    expect(route).toContain("eq('image_slot', parsed.imageSlot)");
    expect(route).toContain('already has different content');
    expect(route).toContain('before additional image slots');
  });

  it('preserves the original item image as the primary thumbnail and exposes ordered slots', () => {
    expect(route).toContain(".order('image_slot', { ascending: true })");
    expect(route).toContain('image_url: signedImages[0]?.image_url || null');
    expect(route).toContain('image_urls: signedImages');
  });
});
