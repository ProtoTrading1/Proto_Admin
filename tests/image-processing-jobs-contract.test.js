import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPreviewDeployment, previewPublishBlock } from '../lib/preview-publish-guard.mjs';

const route = readFileSync(new URL('../api/image-processing-jobs.js', import.meta.url), 'utf8');
const publishRoute = readFileSync(new URL('../api/product-loader-publish.js', import.meta.url), 'utf8');
const staging = readFileSync(new URL('../api/_staging-storage.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/061_image_processing_jobs.sql', import.meta.url), 'utf8');

describe('Image Processing Centre production contract', () => {
  it('separates preview and production records while only enabling apply in production', () => {
    expect(isPreviewDeployment('preview')).toBe(true);
    expect(isPreviewDeployment('production')).toBe(false);
    expect(previewPublishBlock('preview')).toMatchObject({ status: 403, code: 'preview_publish_blocked' });
    expect(previewPublishBlock('production')).toBeNull();
    expect(publishRoute).toContain('const previewBlock = previewPublishBlock();');
  });

  it('requires an owner, review checklist, required audit evidence and a stale-write guard', () => {
    expect(route).toContain('requireOwner(req, res)');
    expect(readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8')).toContain('reviewChecklistComplete');
    expect(publishRoute).toContain('logProductLoaderAudit');
    expect(publishRoute).toContain(".eq('sku', sku)");
  });

  it('uses a protected staged candidate and cleans up an un-applied immutable copy', () => {
    expect(staging).toContain("startsWith('staging/image-processing/')");
    expect(staging).toContain('copyImageProcessingStagedUrlToLive');
    expect(staging).toContain('removeImageProcessingLiveUrl');
    expect(publishRoute).toContain('isImageProcessingAssetUrl');
  });

  it('defines durable, service-role-only jobs and events', () => {
    expect(migration).toContain('create table if not exists public.image_processing_review_jobs');
    expect(migration).toContain('create table if not exists public.image_processing_review_job_events');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on public.image_processing_review_jobs from anon, authenticated');
    expect(migration).toContain("'applying'");
  });
});
