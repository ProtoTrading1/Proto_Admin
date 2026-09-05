import { randomUUID } from 'node:crypto';
import {
  getPortalAdminClient,
  readSiteConfigJson,
  SITE_CONFIG_BUCKET,
  writeSiteConfigJson,
} from './_site-config.js';

const ROOT = 'image-processing';
const INDEX_FILE = `${ROOT}/index.json`;
const MAX_INDEX_JOBS = 250;

function jobFile(id) {
  return `${ROOT}/jobs/${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
}

function safePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function sourceObjectPath(jobId, imageId, filename = 'image.jpg') {
  const ext = String(filename).split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return `${ROOT}/sources/${safePathSegment(jobId)}/${safePathSegment(imageId)}.${ext}`;
}

export async function readImageJob(id) {
  if (!id) return null;
  // Each mutation is followed by another owner action (for example approval
  // then archive). Supabase Storage can briefly serve the previous object
  // version even with `cache: no-store`, so give every manifest read a unique
  // cache key. This keeps the deliberate two-step workflow without making an
  // operator wait for CDN consistency between the steps.
  const job = await readSiteConfigJson(jobFile(id), null, { cacheNonce: randomUUID() });
  return job?.id === id ? job : null;
}

export async function writeImageJob(job) {
  if (!job?.id) throw new Error('Image job id is required');
  const next = {
    ...job,
    version: Math.max(1, Number(job.version) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  return writeSiteConfigJson(jobFile(job.id), next);
}

export async function readImageJobIndex() {
  // Storage object downloads can briefly return a cached copy of index.json
  // immediately after an upsert.  That made a newly-created queue appear and
  // then disappear on the next poll.  The jobs directory listing is backed by
  // Storage metadata, so use it as the authoritative discovery mechanism and
  // keep index.json only as a compatibility/fallback record.
  try {
    const supabase = getPortalAdminClient();
    const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).list(`${ROOT}/jobs`, {
      limit: MAX_INDEX_JOBS,
      offset: 0,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;
    return (data || [])
      .filter((entry) => String(entry?.name || '').endsWith('.json'))
      .map((entry) => ({
        id: String(entry.name).slice(0, -'.json'.length),
        updatedAt: entry.updated_at || entry.updatedAt || entry.created_at || entry.createdAt || '',
      }))
      .filter((entry) => entry.id);
  } catch {
    const data = await readSiteConfigJson(INDEX_FILE, { jobs: [] });
    return Array.isArray(data?.jobs) ? data.jobs : [];
  }
}

export async function indexImageJob(job) {
  const current = await readImageJobIndex();
  const summary = {
    id: job.id,
    status: job.status,
    sourceFlow: job.sourceFlow,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    createdBy: job.createdBy,
    summary: job.summary,
  };
  const jobs = [summary, ...current.filter((row) => row.id !== job.id)]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, MAX_INDEX_JOBS);
  await writeSiteConfigJson(INDEX_FILE, { version: 1, jobs });
  return summary;
}

export async function saveAndIndexImageJob(job) {
  const saved = await writeImageJob(job);
  await indexImageJob(saved);
  return saved;
}

export async function storePrivateSource({ jobId, imageId, filename, contentType, buffer }) {
  const supabase = getPortalAdminClient();
  await supabase.storage.createBucket(SITE_CONFIG_BUCKET, { public: false }).catch(() => {});
  const path = sourceObjectPath(jobId, imageId, filename);
  const { error } = await supabase.storage.from(SITE_CONFIG_BUCKET).upload(path, buffer, {
    contentType: contentType || 'application/octet-stream',
    cacheControl: '0',
    upsert: false,
  });
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
  return path;
}

export async function downloadPrivateSource(path) {
  const supabase = getPortalAdminClient();
  const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function createPrivateSourceUrl(path, expiresIn = 600) {
  const supabase = getPortalAdminClient();
  const { data, error } = await supabase.storage
    .from(SITE_CONFIG_BUCKET)
    .createSignedUrl(path, Math.max(60, Math.min(900, Number(expiresIn) || 600)));
  if (error) throw error;
  return data.signedUrl;
}

function lockPath(jobId, imageId) {
  return `${ROOT}/claims/${safePathSegment(jobId)}/${safePathSegment(imageId)}.json`;
}

/**
 * Cleanup may only remove artifacts whose basename belongs to this exact image
 * inside this exact job. This deliberately excludes a revision's inherited
 * parent source/master, even though both live below the same job directory.
 */
export function isPrivateImageArtifactOwnedBy(job, image, path) {
  const jobId = safePathSegment(job?.id);
  const imageId = safePathSegment(image?.id);
  const value = String(path || '');
  if (!jobId || !imageId || !value.startsWith(`${ROOT}/sources/${jobId}/`)) return false;
  const basename = value.slice(value.lastIndexOf('/') + 1);
  return basename === imageId
    || basename.startsWith(`${imageId}.`)
    || basename.startsWith(`${imageId}-`);
}

export async function removePrivateImageArtifacts(job, image) {
  const supabase = getPortalAdminClient();
  const scope = `${job.id}-${image.id}`;
  const paths = [...new Set([
    image.source?.privatePath,
    image.outputStoragePath,
    image.processed?.transparentPrivatePath,
    image.processed?.websiteReady?.path,
  ].filter((path) => isPrivateImageArtifactOwnedBy(job, image, path)))];
  const claims = [...new Set([
    lockPath('fal-processing-starts', scope),
    lockPath('fal-processing-runs', scope),
  ].filter(Boolean))];
  paths.push(...claims);
  if (!paths.length) return;
  const { error } = await supabase.storage.from(SITE_CONFIG_BUCKET).remove(paths);
  if (error) throw error;
}

export async function removeImageJobRecord(id) {
  if (!id) throw new Error('Image job id is required');
  const supabase = getPortalAdminClient();
  const { error } = await supabase.storage.from(SITE_CONFIG_BUCKET).remove([jobFile(id)]);
  if (error) throw error;
  const current = await readImageJobIndex();
  await writeSiteConfigJson(INDEX_FILE, {
    version: 1,
    jobs: current.filter((row) => row.id !== id),
  });
}

export async function claimImageObject(jobId, imageId, { workerId, ttlSeconds = 300 } = {}) {
  const supabase = getPortalAdminClient();
  const path = lockPath(jobId, imageId);
  const now = Date.now();
  const claim = {
    id: randomUUID(),
    workerId: String(workerId || 'worker').slice(0, 80),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60, Math.min(900, ttlSeconds)) * 1000).toISOString(),
  };
  const bucket = supabase.storage.from(SITE_CONFIG_BUCKET);

  const attempt = async () => bucket.upload(path, JSON.stringify(claim), {
    contentType: 'application/json',
    cacheControl: '0',
    upsert: false,
  });
  let { error } = await attempt();
  if (!error) return claim;
  if (!/already exists|duplicate|resource.*exists/i.test(error.message || '')) throw error;

  const { data } = await bucket.download(path);
  let existing = null;
  try { existing = JSON.parse(await data.text()); } catch { /* stale invalid lock */ }
  if (new Date(existing?.expiresAt || 0).getTime() > now) return null;

  await bucket.remove([path]);
  ({ error } = await attempt());
  if (error) return null;
  return claim;
}

export async function releaseImageObjectClaim(jobId, imageId, claimId) {
  const supabase = getPortalAdminClient();
  const path = lockPath(jobId, imageId);
  const bucket = supabase.storage.from(SITE_CONFIG_BUCKET);
  const { data, error } = await bucket.download(path);
  if (error) return false;
  try {
    const current = JSON.parse(await data.text());
    if (current.id !== claimId) return false;
  } catch {
    return false;
  }
  const { error: removeError } = await bucket.remove([path]);
  return !removeError;
}
