import { requireCronOrAdminKey } from './_admin-auth.js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';

const BACKUP_PREFIX = 'backups';
const RETENTION_DAYS = 14;
const COPY_CONCURRENCY = 4;
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Recursively list file paths under a prefix, skipping the backups/ tree. */
async function listAllFiles(supabase, prefix) {
  const paths = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).list(prefix, { limit: 1000, offset });
    if (error || !data?.length) break;
    for (const entry of data) {
      if (!entry?.name || entry.name.startsWith('.')) continue;
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (childPath === BACKUP_PREFIX || childPath.startsWith(`${BACKUP_PREFIX}/`)) continue;
      const looksLikeFile = entry.metadata != null || /\.[a-z0-9]+$/i.test(entry.name);
      if (looksLikeFile) {
        paths.push(childPath);
        continue;
      }
      const nested = await listAllFiles(supabase, childPath);
      paths.push(...nested);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return paths;
}

/** Run fn over items with at most `limit` in flight (dependency-free). */
async function mapWithConcurrency(items, limit, fn) {
  const list = [...items];
  if (!list.length) return [];
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next;
      next += 1;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, () => worker()));
  return results;
}

async function backupOne(supabase, path, dateFolder) {
  const dest = `${BACKUP_PREFIX}/${dateFolder}/${path}`;
  const { error: copyError } = await supabase.storage.from(SITE_CONFIG_BUCKET).copy(path, dest);
  if (!copyError) return { path, copied: true };
  // copy() refuses to overwrite (re-run on the same day) and may be missing on
  // older clients — fall back to download + upsert upload.
  try {
    const { data, error: downloadError } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(path);
    if (downloadError) throw downloadError;
    const body = Buffer.from(await data.arrayBuffer());
    const { error: uploadError } = await supabase.storage.from(SITE_CONFIG_BUCKET).upload(dest, body, {
      contentType: data.type || 'application/octet-stream',
      upsert: true,
    });
    if (uploadError) throw uploadError;
    return { path, copied: true };
  } catch (err) {
    return { path, copied: false, error: err?.message || String(err) };
  }
}

/** Delete backup date-folders older than the retention window. */
async function pruneOldBackups(supabase, errors) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  let pruned = 0;
  const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).list(BACKUP_PREFIX, { limit: 1000 });
  if (error) {
    errors.push(`prune list: ${error.message}`);
    return pruned;
  }
  for (const entry of data || []) {
    const name = String(entry?.name || '');
    // Conservative: only ever delete exact backups/YYYY-MM-DD/ date folders.
    if (!DATE_FOLDER_RE.test(name) || name >= cutoff) continue;
    const folder = `${BACKUP_PREFIX}/${name}`;
    try {
      const files = await listAllFilesUnderBackupFolder(supabase, folder);
      const safe = files.filter((p) => /^backups\/\d{4}-\d{2}-\d{2}\//.test(p));
      for (let i = 0; i < safe.length; i += 100) {
        const chunk = safe.slice(i, i + 100);
        const { error: removeError } = await supabase.storage.from(SITE_CONFIG_BUCKET).remove(chunk);
        if (removeError) throw removeError;
        pruned += chunk.length;
      }
    } catch (err) {
      errors.push(`prune ${folder}: ${err?.message || err}`);
    }
  }
  return pruned;
}

/** Same walker as listAllFiles but scoped inside a backups/ date folder. */
async function listAllFilesUnderBackupFolder(supabase, prefix) {
  const paths = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).list(prefix, { limit: 1000, offset });
    if (error || !data?.length) break;
    for (const entry of data) {
      if (!entry?.name || entry.name.startsWith('.')) continue;
      const childPath = `${prefix}/${entry.name}`;
      const looksLikeFile = entry.metadata != null || /\.[a-z0-9]+$/i.test(entry.name);
      if (looksLikeFile) {
        paths.push(childPath);
        continue;
      }
      const nested = await listAllFilesUnderBackupFolder(supabase, childPath);
      paths.push(...nested);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return paths;
}

/**
 * Nightly cron — snapshot every object in the site-config bucket (excluding
 * backups/) to backups/<YYYY-MM-DD>/<path>, then prune snapshots older than
 * 14 days. Single-file failures are collected, never thrown.
 */
export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const supabase = getPortalAdminClient();
  const dateFolder = new Date().toISOString().slice(0, 10);
  const errors = [];

  let files = [];
  try {
    files = await listAllFiles(supabase, '');
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to list site-config bucket' });
  }

  const results = await mapWithConcurrency(files, COPY_CONCURRENCY, (path) => backupOne(supabase, path, dateFolder));
  const copied = results.filter((r) => r.copied).length;
  for (const r of results) {
    if (!r.copied) errors.push(`${r.path}: ${r.error}`);
  }

  const pruned = await pruneOldBackups(supabase, errors);

  return res.status(200).json({
    ok: true,
    date: dateFolder,
    copied,
    skipped: files.length - copied,
    pruned,
    errors,
  });
}
