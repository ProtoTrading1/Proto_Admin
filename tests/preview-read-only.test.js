import { describe, expect, it } from 'vitest';
import { previewReadOnlyBlock } from '../lib/preview-read-only.mjs';

const enabled = '1';
const url = (path) => `https://preview.example${path}`;

describe('preview read-only API guard', () => {
  it('leaves every request unchanged when the flag is off', () => {
    for (const enabledValue of [undefined, '', '0', 'true']) {
      expect(previewReadOnlyBlock({ method: 'POST', url: url('/api/stock-actions'), body: { action: 'archive' } }, enabledValue)).toBeNull();
      expect(previewReadOnlyBlock({ method: 'GET', url: url('/api/unknown') }, enabledValue)).toBeNull();
    }
  });

  it('allows only the explicitly listed read endpoints and read actions', () => {
    for (const path of [
      '/api/auth-check', '/api/taxonomy', '/api/catalog', '/api/products',
      '/api/specials', '/api/featured-products', '/api/banner',
      '/api/nutstore-browse', '/api/nutstore-thumbnail', '/api/nutstore-process',
      '/api/product-loader-lookup', '/api/product-loader-diag',
      '/api/product-loader-dormant', '/api/product-loader-publish-history',
      '/api/bridge-status', '/api/live-shoppers',
    ]) {
      expect(previewReadOnlyBlock({ method: 'GET', url: url(path) }, enabled), path).toBeNull();
    }
    for (const path of ['/api/auth-check', '/api/product-loader-batch-lookup', '/api/nutstore-batch-lookup', '/api/product-loader-variant-preview']) {
      expect(previewReadOnlyBlock({ method: 'POST', url: url(path) }, enabled), path).toBeNull();
    }
    for (const action of ['listLive', 'listArchived']) {
      expect(previewReadOnlyBlock({ method: 'POST', url: url('/api/stock-actions'), body: { action } }, enabled)).toBeNull();
    }
  });

  it('blocks unknown GET endpoints, including operational routes that may mutate', () => {
    for (const path of ['/api/unknown', '/api/cron-sync', '/api/product-loader-publish']) {
      expect(previewReadOnlyBlock({ method: 'GET', url: url(path) }, enabled)).toMatchObject({ status: 403, code: 'preview_read_only' });
    }
  });

  it('blocks every non-allowlisted method and all stock mutation actions', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      expect(previewReadOnlyBlock({ method, url: url('/api/products') }, enabled), method).toMatchObject({ status: 403 });
    }
    for (const action of ['create', 'archive', 'unarchive', 'setToOrder', 'setProductAvailability', 'deleteStagedPreview', 'anything-else']) {
      expect(previewReadOnlyBlock({ method: 'POST', url: url('/api/stock-actions'), body: { action } }, enabled), action).toMatchObject({ status: 403 });
    }
  });

  it('fails closed for missing, malformed, or non-object stock action bodies', () => {
    for (const body of [null, undefined, {}, [], 'listLive', { action: ['listLive'] }]) {
      expect(previewReadOnlyBlock({ method: 'POST', url: url('/api/stock-actions'), body }, enabled)).toMatchObject({ status: 403 });
    }
  });

  it('does not let encoded API path spellings reach an allowlisted route', () => {
    for (const path of ['/%61pi/auth-check', '/api/%61uth-check', '/api/auth%2dcheck', '//api/auth-check']) {
      expect(previewReadOnlyBlock({ method: 'GET', url: url(path) }, enabled), path).toMatchObject({ status: 403 });
    }
  });
});
