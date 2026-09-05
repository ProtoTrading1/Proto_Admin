/**
 * Preview deployments are for review only.  Keep this check server-side so a
 * browser request cannot accidentally write preview work into the live product
 * catalogue.  Local development deliberately remains available for fixtures.
 */
function deploymentEnvironment() {
  return globalThis.process?.env?.VERCEL_ENV;
}

export function isPreviewDeployment(environment = deploymentEnvironment()) {
  return String(environment || '').trim().toLowerCase() === 'preview';
}

export function previewPublishBlock(environment = deploymentEnvironment()) {
  if (!isPreviewDeployment(environment)) return null;
  return {
    status: 403,
    code: 'preview_publish_blocked',
    error: 'Publishing is disabled in preview. Review the processed image here; live publishing is available only in production.',
  };
}
