import { describe, expect, it } from 'vitest';
import { installPreviewWriteGuard, isReadOnlyPreviewHost, shouldBlockPreviewRequest } from '../src/lib/previewWriteGuard.js';

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

  it('allows only the audited read-only POST API endpoints', () => {
    const request = {
      hostname: 'protoportal-admin-example-proto-team.vercel.app',
      origin: 'https://protoportal-admin-example-proto-team.vercel.app',
    };
    for (const path of [
      '/api/auth-check', '/api/product-loader-batch-lookup',
      '/api/nutstore-batch-lookup', '/api/product-loader-variant-preview',
    ]) {
      expect(shouldBlockPreviewRequest({ ...request, url: path, method: 'POST' }), path).toBe(false);
    }
    for (const action of ['listLive', 'listArchived']) {
      expect(shouldBlockPreviewRequest({
        ...request,
        url: '/api/stock-actions',
        method: 'POST',
        body: JSON.stringify({ action }),
      })).toBe(false);
    }
    for (const body of [undefined, '{', JSON.stringify({ action: 'archive' })]) {
      expect(shouldBlockPreviewRequest({ ...request, url: '/api/stock-actions', method: 'POST', body })).toBe(true);
    }
  });

  it('blocks direct Supabase REST and Storage mutations, while preserving normal auth calls', () => {
    const request = { hostname: 'protoportal-admin-example-proto-team.vercel.app', origin: 'https://preview.example' };
    for (const url of [
      'https://project.supabase.co/rest/v1/products',
      'https://project.supabase.co/rest/v1/rpc/update_product',
      'https://project.supabase.co/storage/v1/object/product-images/test.jpg',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(shouldBlockPreviewRequest({ ...request, url, method }), `${method} ${url}`).toBe(true);
      }
      expect(shouldBlockPreviewRequest({ ...request, url, method: 'GET' })).toBe(false);
    }
    for (const url of [
      'https://project.supabase.co/auth/v1/token',
      'https://project.supabase.co/auth/v1/logout',
      'https://other-service.example/api/write',
    ]) {
      expect(shouldBlockPreviewRequest({ ...request, url, method: 'POST' }), url).toBe(false);
    }
  });

  it('does not block direct Supabase writes on production hosts', () => {
    expect(shouldBlockPreviewRequest({
      hostname: 'admin.proto.co.za',
      origin: 'https://admin.proto.co.za',
      url: 'https://project.supabase.co/rest/v1/products',
      method: 'POST',
    })).toBe(false);
  });

  it('inspects Request and init bodies, failing closed when an allowed POST body is malformed', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls = [];
    const fakeWindow = {
      location: { hostname: 'protoportal-admin-example-proto-team.vercel.app', origin: 'https://preview.example' },
      fetch: async (...args) => { calls.push(args); return new Response('passed'); },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    try {
      installPreviewWriteGuard();
      const requestUrl = 'https://preview.example/api/stock-actions';
      const requestRead = new Request(requestUrl, { method: 'POST', body: JSON.stringify({ action: 'listLive' }) });
      expect((await window.fetch(requestRead)).status).toBe(200);
      expect((await window.fetch(requestUrl, { method: 'POST', body: JSON.stringify({ action: 'listArchived' }) })).status).toBe(200);
      expect((await window.fetch(requestUrl, { method: 'POST', body: '{' })).status).toBe(409);
      expect((await window.fetch(requestUrl, { method: 'POST' })).status).toBe(409);
      expect((await window.fetch('https://project.supabase.co/rest/v1/products', { method: 'PATCH', body: '{}' })).status).toBe(409);
      expect(calls).toHaveLength(2);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete globalThis.window;
    }
  });
});
