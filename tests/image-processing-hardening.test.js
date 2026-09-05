import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ownedImageJobStagingUrls } from '../api/purge-expired-staging.js';

const pipeline = readFileSync(new URL('../api/_image-pipeline.js', import.meta.url), 'utf8');

describe('Image Processing Centre hardening', () => {
  it('purges only staged URLs declared under the matching job prefix', () => {
    const job = {
      id: 'job-123',
      source_url: 'https://example.supabase.co/storage/v1/object/public/product-images/staging/image-processing/job-123/source.jpg',
      source_storage_path: 'staging/image-processing/job-123/source.jpg',
      processed_url: 'https://example.supabase.co/storage/v1/object/public/product-images/staging/legacy/other-job.jpg',
      processed_storage_path: 'staging/image-processing/job-123/processed.jpg',
    };
    expect(ownedImageJobStagingUrls(job)).toEqual([job.source_url]);
  });

  it('never considers an external or URL-only source image deletable staging', () => {
    expect(ownedImageJobStagingUrls({
      id: 'job-123',
      source_url: 'https://external.example/staging/image-processing/job-123/source.jpg',
      source_storage_path: null,
    })).toEqual([]);
  });

  it('uses the shared server-side stock client for transformed-image storage', () => {
    expect(pipeline).toContain("import { getStockClient } from './_stock-client.js';");
    expect(pipeline).toContain('return getStockClient();');
    expect(pipeline).not.toContain('process.env.VITE_STOCK_SUPABASE_URL');
  });
});
