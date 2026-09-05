#!/usr/bin/env node
/**
 * Deploy ONLY the protoportal-admin Vercel project.
 * Never run bare `vercel deploy` — the CLI may target protoportal-main.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ADMIN_PROJECT_ID = 'prj_tpEwYIxCWnUxH9yIX9c6vxXuivB4';
const ADMIN_SCOPE = process.env.VERCEL_ADMIN_SCOPE || 'proto-team';
const LINK_FILE = '.vercel/project.json';

/**
 * The team that owns this project has changed once already (a hard-coded org
 * id went stale and started answering 404), so the id is no longer written
 * here. The CLI refuses VERCEL_PROJECT_ID without VERCEL_ORG_ID, and `--scope`
 * does not satisfy that pair — so the org id is resolved, in order, from:
 *
 *   1. VERCEL_ORG_ID in the environment (CI, or a deliberate override)
 *   2. .vercel/project.json, written by `vercel link` and gitignored
 *
 * Whichever wins, the linked project id is checked against ADMIN_PROJECT_ID so
 * a link pointing at protoportal-main can never deploy from here.
 */
function resolveOrgId() {
  if (process.env.VERCEL_ORG_ID) {
    return { orgId: process.env.VERCEL_ORG_ID, source: 'VERCEL_ORG_ID' };
  }

  let link;
  try {
    link = JSON.parse(readFileSync(LINK_FILE, 'utf8'));
  } catch {
    console.error(`ERROR: No Vercel org id available.

Set VERCEL_ORG_ID, or link this checkout once:

  npx vercel@latest login
  npx vercel@latest link --yes --scope ${ADMIN_SCOPE} --project protoportal-admin

That writes ${LINK_FILE} (gitignored) and every later deploy just works.`);
    process.exit(1);
  }

  if (link.projectId && link.projectId !== ADMIN_PROJECT_ID) {
    console.error(`ERROR: ${LINK_FILE} points at project ${link.projectId}, not protoportal-admin (${ADMIN_PROJECT_ID}). Aborting.`);
    process.exit(1);
  }
  if (!link.orgId) {
    console.error(`ERROR: ${LINK_FILE} has no orgId. Re-run: npx vercel@latest link --yes --scope ${ADMIN_SCOPE} --project protoportal-admin`);
    process.exit(1);
  }
  return { orgId: link.orgId, source: LINK_FILE };
}

const { orgId, source } = resolveOrgId();

const env = {
  ...process.env,
  VERCEL_PROJECT_ID: ADMIN_PROJECT_ID,
  VERCEL_ORG_ID: orgId,
};

console.log(`Deploying protoportal-admin (NOT protoportal-main) — org from ${source}…`);

const result = spawnSync(
  'npx',
  ['vercel@latest', 'deploy', '--prod', '--yes'],
  { env, stdio: 'pipe', encoding: 'utf8' },
);

const out = `${result.stdout || ''}\n${result.stderr || ''}`;
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');

if (result.status !== 0) {
  process.exit(result.status || 1);
}

if (/protoportal-main/i.test(out) && !/protoportal-admin/i.test(out)) {
  console.error('\nERROR: Deployment targeted protoportal-main. Aborting.');
  process.exit(1);
}

if (!/protoportal-admin/i.test(out)) {
  console.error('\nWARN: Could not confirm protoportal-admin in deploy output — verify in Vercel dashboard.');
}

console.log('\nOK: protoportal-admin production deploy finished.');
