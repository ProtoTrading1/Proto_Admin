#!/usr/bin/env node

/**
 * Release-readiness check for the Image Processing Centre.
 *
 * Usage:
 *   node scripts/check-image-processing-release-env.mjs --environment=preview
 *   node scripts/check-image-processing-release-env.mjs --environment=production
 *
 * The check prints variable names only. It never prints credential values.
 */

const requestedEnvironment = process.argv
  .find((argument) => argument.startsWith('--environment='))
  ?.split('=')[1]
  ?.trim()
  ?.toLowerCase();
const environment = requestedEnvironment || String(process.env.VERCEL_ENV || '').trim().toLowerCase();

if (!['preview', 'production'].includes(environment)) {
  console.log('Image Processing Centre env check skipped: pass --environment=preview or --environment=production for a release gate.');
  process.exit(0);
}

const hasUser = Boolean(String(process.env.NUTSTORE_USER || process.env.NUTSTORE_WEBDAV_USER || '').trim());
const hasPassword = Boolean(String(process.env.NUTSTORE_APP_PASSWORD || process.env.NUTSTORE_WEBDAV_PASSWORD || '').trim());

if (!hasUser || !hasPassword) {
  const missing = [];
  if (!hasUser) missing.push('NUTSTORE_USER (or NUTSTORE_WEBDAV_USER)');
  if (!hasPassword) missing.push('NUTSTORE_APP_PASSWORD (or NUTSTORE_WEBDAV_PASSWORD)');
  console.error(`Image Processing Centre ${environment} release blocked. Missing: ${missing.join(', ')}.`);
  console.error('Add the approved variables to the matching Vercel environment and redeploy. Credential values are never accepted by this script.');
  process.exit(1);
}

console.log(`Image Processing Centre ${environment} Nutstore variable names are present. No values were printed.`);
