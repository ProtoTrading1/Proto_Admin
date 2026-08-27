import { describe, expect, it } from 'vitest';
import { isReadOnlyPreviewHost, shouldBlockPreviewRequest } from '../src/lib/previewWriteGuard.js';

describe('preview write guard', () => {
  it('treats hashed Vercel deployments as read-only but leaves production hosts alone', () => {
    expect(isReadOnlyPreviewHost('protoportal-admin-example-proto-team.vercel.app')).toBe(true);
    expect(isReadOnlyPreviewHost('admin.proto.co.za')).toBe(false);
    expect(isReadOnlyPreviewHost('protoportal-admin-proto-team.vercel.app')).toBe(false);
  });

  it('blocks same-origin API writes in previews while allowing reads', () => {
    const request = {
      hostname: 'protoportal-admin-example-proto-team.vercel.app',
      origin: 'https://protoportal-admin-example-proto-team.vercel.app',
      url: '/api/site-config',
    };

    expect(shouldBlockPreviewRequest({ ...request, method: 'POST' })).toBe(true);
    expect(shouldBlockPreviewRequest({ ...request, method: 'DELETE' })).toBe(true);
    expect(shouldBlockPreviewRequest({ ...request, method: 'GET' })).toBe(false);
  });

  it('does not interfere with authentication or other external services', () => {
    expect(shouldBlockPreviewRequest({
      hostname: 'protoportal-admin-example-proto-team.vercel.app',
      origin: 'https://protoportal-admin-example-proto-team.vercel.app',
      url: 'https://example.supabase.co/auth/v1/token',
      method: 'POST',
    })).toBe(false);
  });
});
