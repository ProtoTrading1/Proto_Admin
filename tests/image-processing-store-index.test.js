import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  readSiteConfigJson: vi.fn(),
}));

vi.mock('../api/_site-config.js', () => ({
  SITE_CONFIG_BUCKET: 'site-config',
  getPortalAdminClient: () => ({
    storage: {
      from: () => ({ list: mocks.list }),
    },
  }),
  readSiteConfigJson: mocks.readSiteConfigJson,
  writeSiteConfigJson: vi.fn(),
}));

import { readImageJob, readImageJobIndex } from '../api/_image-processing-store.js';

describe('image-processing queue discovery', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.readSiteConfigJson.mockReset();
  });

  it('discovers durable job manifests from storage metadata instead of a cached index object', async () => {
    mocks.list.mockResolvedValue({
      data: [
        { name: 'ipc_new.json', updated_at: '2026-08-15T01:00:00.000Z' },
        { name: '.emptyFolderPlaceholder' },
        { name: 'ipc_old.json', created_at: '2026-08-14T23:00:00.000Z' },
      ],
      error: null,
    });

    await expect(readImageJobIndex()).resolves.toEqual([
      { id: 'ipc_new', updatedAt: '2026-08-15T01:00:00.000Z' },
      { id: 'ipc_old', updatedAt: '2026-08-14T23:00:00.000Z' },
    ]);
    expect(mocks.readSiteConfigJson).not.toHaveBeenCalled();
  });

  it('falls back to the compatibility index only when metadata listing fails', async () => {
    mocks.list.mockResolvedValue({ data: null, error: new Error('metadata unavailable') });
    mocks.readSiteConfigJson.mockResolvedValue({ jobs: [{ id: 'ipc_fallback' }] });

    await expect(readImageJobIndex()).resolves.toEqual([{ id: 'ipc_fallback' }]);
  });

  it('uses a unique cache key for every mutable job-manifest read', async () => {
    mocks.readSiteConfigJson.mockResolvedValue({ id: 'ipc_fresh' });

    await expect(readImageJob('ipc_fresh')).resolves.toEqual({ id: 'ipc_fresh' });
    expect(mocks.readSiteConfigJson).toHaveBeenCalledWith(
      'image-processing/jobs/ipc_fresh.json',
      null,
      { cacheNonce: expect.any(String) },
    );
  });

  it('requires mutable private JSON reads and writes to bypass CDN caching', () => {
    const source = readFileSync(new URL('../api/_site-config.js', import.meta.url), 'utf8');
    expect(source).toContain(".download(file, cacheNonce == null ? {} : { cacheNonce: String(cacheNonce) }, { cache: 'no-store' })");
    expect(source).toContain("cacheControl: '0'");
  });
});
