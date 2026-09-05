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

  it('allows the Product Loader filename lookup but still blocks publishing', () => {
    const request = {
      hostname: 'protoportal-admin-example-proto-team.vercel.app',
      origin: 'https://protoportal-admin-example-proto-team.vercel.app',
    };

    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/product-loader-batch-lookup',
      method: 'POST',
    })).toBe(false);
    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/product-loader-publish',
      method: 'POST',
    })).toBe(true);
    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/product-loader-image-replace',
      method: 'POST',
    })).toBe(true);
  });

  it('allows only the Apollo read-only analysis enqueue in previews', () => {
    const request = {
      hostname: 'protoportal-admin-example-proto-team.vercel.app',
      origin: 'https://protoportal-admin-example-proto-team.vercel.app',
    };

    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/codex-analytics-jobs',
      method: 'POST',
    })).toBe(false);
    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/codex-analytics-jobs',
      method: 'PUT',
    })).toBe(true);
    expect(shouldBlockPreviewRequest({
      ...request,
      url: '/api/codex-analytics-worker',
      method: 'POST',
    })).toBe(true);
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
