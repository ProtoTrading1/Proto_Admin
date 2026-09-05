import { requireCronOrAdminKey } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { collectImageUrlsFromRow, removeStagingObjects, collectLiveReferencedStagingPaths, storagePathFromPublicUrl } from './_staging-storage.js';

function isMissingColumn(error, column) {
  return new RegExp(`column.*${column}|${column}.*does not exist`, 'i').test(String(error?.message || ''));
}

/**
 * Only delete staged objects which were created under this exact review job.
 * URL-only source images can be external, and must never be treated as
 * deletable storage merely because their URL happens to contain /staging/.
 */
export function ownedImageJobStagingUrls(job = {}) {
  const id = String(job.id || '').trim();
  if (!id) return [];
  const prefix = `staging/image-processing/${id}/`;
  return [
    ['source_url', 'source_storage_path'],
    ['processed_url', 'processed_storage_path'],
  ].flatMap(([urlKey, pathKey]) => {
    const url = String(job[urlKey] || '').trim();
    const declaredPath = String(job[pathKey] || '').trim();
    const actualPath = storagePathFromPublicUrl(url);
    return declaredPath.startsWith(prefix) && actualPath === declaredPath ? [url] : [];
  });
}

/** Daily cron — remove expired Approval previews and staging/* storage objects. */
export default async function handler(req, res) {
  if (!(await requireCronOrAdminKey(req, res))) return;

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const sb = getStockClient();
  const now = new Date().toISOString();
  const fallbackCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const expired = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    let query = sb
      .from('archived_products')
      .select('*')
      .eq('archived_by', 'new-products')
      .not('staged_expires_at', 'is', null)
      .lte('staged_expires_at', now)
      .order('sku', { ascending: true })
      .range(from, from + pageSize - 1);
    let { data, error } = await query;

    // Older projects may not yet have the optional staging expiry columns.
    // The queue was always temporary, so its updated_at provides a conservative
    // seven-day fallback rather than allowing previews to accumulate forever.
    if (error && isMissingColumn(error, 'staged_expires_at')) {
      ({ data, error } = await sb
        .from('archived_products')
        .select('*')
        .eq('archived_by', 'new-products')
        .lte('updated_at', fallbackCutoff)
        .order('sku', { ascending: true })
        .range(from, from + pageSize - 1));
    }

    if (error) {
      console.error('purge-expired-staging:', error.message);
      return res.status(500).json({ error: error.message });
    }
    expired.push(...(data || []));
    if ((data || []).length < pageSize) break;
    from += pageSize;
  }

  let removedFiles = 0;
  let removedRows = 0;
  let skippedFiles = 0;
  let expiredImageJobs = 0;
  let purgedImageJobFiles = 0;

  const liveStagingRefs = await collectLiveReferencedStagingPaths(sb);

  for (const row of expired) {
    const urls = collectImageUrlsFromRow(row);
    const safeUrls = urls.filter((url) => {
      const path = storagePathFromPublicUrl(url);
      if (!path?.startsWith('staging/')) return false;
      if (liveStagingRefs.has(path)) {
        skippedFiles += 1;
        return false;
      }
      return true;
    });
    const { removed } = await removeStagingObjects(sb, safeUrls, { skipLiveReferenced: false });
    removedFiles += removed;
    const { error: delErr } = await sb
      .from('archived_products')
      .delete()
      .eq('sku', row.sku)
      .eq('archived_by', 'new-products');
    if (!delErr) removedRows += 1;
  }

  // Image Processing Centre jobs retain their audit record, but their staged
  // source/candidate files expire after seven days if they were not applied.
  const { data: jobs, error: jobsError } = await sb
    .from('image_processing_review_jobs')
    .select('id, source_url, processed_url, source_storage_path, processed_storage_path')
    .in('status', ['queued', 'needs_attention', 'ready_for_review', 'approved'])
    .lte('expires_at', now)
    .limit(500);
  if (jobsError && !/image_processing_review_jobs.*does not exist|relation.*image_processing_review_jobs/i.test(jobsError.message || '')) {
    console.error('purge-expired-staging jobs:', jobsError.message);
    return res.status(500).json({ error: jobsError.message });
  }
  for (const job of jobs || []) {
    const { removed } = await removeStagingObjects(sb, ownedImageJobStagingUrls(job), { skipLiveReferenced: false });
    purgedImageJobFiles += removed;
    const { error: updateError } = await sb
      .from('image_processing_review_jobs')
      .update({ status: 'expired', updated_at: now })
      .eq('id', job.id)
      .in('status', ['queued', 'needs_attention', 'ready_for_review', 'approved']);
    if (updateError) continue;
    expiredImageJobs += 1;
    await sb.from('image_processing_review_job_events').insert({
      job_id: job.id,
      event: 'expired',
      details: { expiresAt: now, source: 'purge-expired-staging' },
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    purgedRows: removedRows,
    purgedFiles: removedFiles,
    skippedLiveReferenced: skippedFiles,
    expiredImageJobs,
    purgedImageJobFiles,
    checkedAt: now,
  });
}
