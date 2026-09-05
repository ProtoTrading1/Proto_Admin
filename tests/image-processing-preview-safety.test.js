import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPreviewDeployment, previewPublishBlock } from '../lib/preview-publish-guard.mjs';

const publishRoute = readFileSync(new URL('../api/product-loader-publish.js', import.meta.url), 'utf8');

describe('Image Processing Centre preview publishing safety', () => {
  it('recognises Vercel preview deployments and blocks publication there', () => {
    expect(isPreviewDeployment('preview')).toBe(true);
    expect(isPreviewDeployment('production')).toBe(false);
    expect(previewPublishBlock('preview')).toMatchObject({
      status: 403,
      code: 'preview_publish_blocked',
    });
  });

  it('enforces the preview block in the server-side publishing route before catalogue access', () => {
    expect(publishRoute).toContain("import { previewPublishBlock } from '../lib/preview-publish-guard.mjs';");
    expect(publishRoute).toContain('const previewBlock = previewPublishBlock();');
    expect(publishRoute.indexOf('const previewBlock = previewPublishBlock();')).toBeLessThan(
      publishRoute.indexOf('const sb = getStockClient();'),
    );
  });

  it('keeps reviewed Centre assets out of the legacy direct publishing route', () => {
    expect(publishRoute).toContain("import { isImageProcessingAssetUrl } from './_staging-storage.js';");
    expect(publishRoute).toContain("code: 'image_processing_centre_only'");
  });
});
