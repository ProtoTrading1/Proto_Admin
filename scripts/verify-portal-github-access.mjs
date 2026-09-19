#!/usr/bin/env node
/**
 * Verify Cloud Agent can push to Proto-Website- (required for Vercel Preview).
 * Run: node scripts/verify-portal-github-access.mjs
 */
import { spawnSync } from 'node:child_process';

const PORTAL_REPO = 'danieljoffeinfo-web/Proto-Website-';
const ADMIN_REPO = 'danieljoffeinfo-web/protoportal-admin';

function ghApi(path) {
  const r = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function checkPush(repo) {
  const data = ghApi(`repos/${repo}`);
  if (!data?.permissions) return { repo, push: null, error: 'API unavailable' };
  return { repo, push: data.permissions.push === true };
}

console.log('Portal Cloud Agent — GitHub access check\n');

const portal = checkPush(PORTAL_REPO);
const admin = checkPush(ADMIN_REPO);

for (const r of [portal, admin]) {
  const status = r.push === true ? 'ALLOWED' : r.push === false ? 'DENIED' : 'UNKNOWN';
  const icon = r.push === true ? '✓' : '✗';
  console.log(`${icon} ${r.repo}`);
  console.log(`  push: ${status}`);
}

console.log('');

if (portal.push === true) {
  console.log('OK: Proto-Website- push access — Vercel Preview workflow can proceed.');
  process.exit(0);
}

console.log('BLOCKED: Proto-Website- push denied (cursor[bot] 403).');
console.log('');
console.log('Fix: docs/portal-cloud-agent-deployment.md');
console.log('  1. GitHub → Cursor app → grant access to Proto-Website-');
console.log('  2. Cursor dashboard → Integrations → reconnect GitHub');
console.log('  3. Optional: add GH_TOKEN to Cloud Agent secrets');
process.exit(1);
