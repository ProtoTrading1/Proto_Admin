import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Download,
  FolderOpen,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { exportBatchReportCsv, isImageFile } from '../../lib/parseIntakeFilename';
import {
  archiveLoaderImageItem,
  lookupFilenames,
  logPublishFailure,
  publishLoaderColourVariant,
  publishLoaderImageItem,
  syncLoaderColourVariantGroup,
} from '../../lib/productLoaderApi';
import { catalogueDisplayTitle, loaderCodeLabel } from '../../lib/productLoaderDisplay.js';
import LoaderCodeEllipsis from './LoaderCodeEllipsis.jsx';
import CategoryPathSelect from './CategoryPathSelect';
import { loaderPriceSourceLabel } from '../../../lib/catalogue-price.mjs';
import {
  clearProductLoaderUploadDraft,
  getProductLoaderUploadDraft,
  getProductLoaderUploadDraftRecovery,
  saveProductLoaderUploadDraft,
} from '../../lib/productLoaderUploadDraft.js';

/**
 * Upload tab — one place for both a single image and a whole folder. Each
 * filename is parsed as a product code (Positill code = text before the first
 * hyphen), looked up via the bridge, then published live or sent to archive.
 * A single image is just a one-row batch; the folder input and the image input
 * feed the exact same lookup → publish/archive pipeline. (Merges the former
 * "Single Image" + "Local Folder" tabs; the flow is unchanged.)
 */

function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

const GROUP_LABELS = {
  ready: 'Ready',
  needs_review: 'Needs Review',
  not_found: 'Not Found',
};

const WARNING_LABELS = {
  image_exists: 'Image already exists',
  low_stock: 'No available stock',
  price_zero: 'Price missing',
  price_suspect_ex_vat: 'Price looks EX VAT — check Positill (×1.15 lands on .00/.50)',
  price_source_cached: 'Live Positill unavailable — cached price needs review',
  needs_category: 'Category required',
  not_in_catalog: 'Positill code not found',
  too_many_variant_images: 'Maximum 4 images per colour',
};

function rowStatusLabel(row) {
  if (row.processError) return `${row.status || row.group} — ${row.processError}`;
  const warnings = (row.warnings || []).map((warning) => WARNING_LABELS[warning] || warning);
  return [row.status || row.group, ...warnings].filter(Boolean).join(' — ');
}

function isDraftRowFinished(row) {
  return row.status === 'done' || row.status === 'archived';
}

// Regular products are independent work units. All images for one recognised
// colour are one work unit so their four image slots publish atomically.
// Kept modest so a large folder doesn't overwhelm the serverless upload route.
const FOLDER_CONCURRENCY = 5;

/** Run `task` over items with a bounded number of concurrent workers. */
async function runWithConcurrency(items, limit, task) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await task(items[idx], idx);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

export default function ProductLoaderUpload({
  taxonomyTree,
  batchDefaultPathIds,
  setBatchDefaultPathIds,
  batchOverwrite,
  setBatchOverwrite,
  onShowToast,
  onProcessFiles,
}) {
  const folderRef = useRef(null);
  const filesRef = useRef(null);
  const [items, setItems] = useState(() => getProductLoaderUploadDraft() || []);
  const [scanning, setScanning] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stats, setStats] = useState({ published: 0, dormant: 0, failed: 0 });
  const [groupColourVariants, setGroupColourVariants] = useState(true);
  const [sourceFiles, setSourceFiles] = useState(() => (
    (getProductLoaderUploadDraft() || []).map((item) => item.file).filter(Boolean)
  ));
  const [draftRecovery, setDraftRecovery] = useState(() => getProductLoaderUploadDraftRecovery());

  const batchDefaultCategoryId = batchDefaultPathIds?.[0] || '';

  const grouped = useMemo(() => ({
    ready: items.filter((i) => i.group === 'ready'),
    needs_review: items.filter((i) => i.group === 'needs_review'),
    not_found: items.filter((i) => i.group === 'not_found'),
  }), [items]);

  const summary = useMemo(() => ({
    found: items.length,
    matched: items.filter((i) => i.canPublish).length,
    ready: grouped.ready.length,
    needsReview: grouped.needs_review.length,
    notFound: grouped.not_found.length,
    published: stats.published,
    dormant: stats.dormant,
  }), [items, grouped, stats]);

  const handleFiles = async (fileList) => {
    const files = [...(fileList || [])].filter(isImageFile);
    if (!files.length) {
      setError('No image files found in that selection.');
      return;
    }
    setScanning(true);
    setSourceFiles(files);
    setError('');
    setItems([]);
    setStats({ published: 0, dormant: 0, failed: 0 });
    try {
      const merged = await lookupFilenames(files.map((f) => f.name), files, { groupColourVariants });
      for (const row of merged) {
        if (row.file) row.previewUrl = URL.createObjectURL(row.file);
      }
      setItems(merged);
      saveProductLoaderUploadDraft(merged);
      setDraftRecovery(getProductLoaderUploadDraftRecovery());
      onShowToast?.(`Scanned ${merged.length} image${merged.length === 1 ? '' : 's'} — ${merged.filter((i) => i.group === 'ready').length} ready`, 'success');
    } catch (err) {
      setError(err.message || 'Image scan failed');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    saveProductLoaderUploadDraft(items);
    setDraftRecovery(getProductLoaderUploadDraftRecovery());
  }, [items]);

  const discardDraft = () => {
    clearProductLoaderUploadDraft();
    setItems([]);
    setSourceFiles([]);
    setDraftRecovery(null);
    setStats({ published: 0, dormant: 0, failed: 0 });
    setError('');
  };

  const clearDraftAfterCompleteAction = () => {
    clearProductLoaderUploadDraft();
    setSourceFiles([]);
    setDraftRecovery(null);
  };

  const clearDraftIfEveryRowFinished = (completedFilenames) => {
    if (!items.every((row) => completedFilenames.has(row.filename) || isDraftRowFinished(row))) return;
    clearDraftAfterCompleteAction();
  };

  const publishItems = async (targetItems) => {
    const ready = targetItems.filter((i) => (i.group === 'ready' || i.group === 'needs_review') && i.file && i.code);
    if (!ready.length) return;
    const needsCategory = ready.some((i) => !i.websiteRow?.category);
    if (needsCategory && !batchDefaultCategoryId) {
      setError('Pick a default category for new products.');
      return;
    }

    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    const variantGroups = new Map();
    const workUnits = [];
    for (const row of ready) {
      if (!row.isColourVariant) {
        workUnits.push({ key: row.filename, rows: [row], isColourVariant: false });
        continue;
      }
      if (!variantGroups.has(row.code)) {
        const unit = { key: row.code, rows: [], isColourVariant: true };
        variantGroups.set(row.code, unit);
        workUnits.push(unit);
      }
      variantGroups.get(row.code).rows.push(row);
    }

    setProgress({ done: 0, total: workUnits.length, current: '' });
    let published = 0;
    let publishedImages = 0;
    let failed = 0;
    let done = 0;
    const publishedColourRows = [];

    await runWithConcurrency(workUnits, FOLDER_CONCURRENCY, async (unit) => {
      const filenames = new Set(unit.rows.map((row) => row.filename));
      setItems((prev) => prev.map((row) => (
        filenames.has(row.filename) ? { ...row, status: 'processing' } : row
      )));
      try {
        if (unit.isColourVariant) {
          await publishLoaderColourVariant(unit.rows, {
            taxonomyTree,
            findNode,
            defaultCategoryPathIds: batchDefaultPathIds,
            overwrite: batchOverwrite,
          });
          publishedColourRows.push(...unit.rows);
        } else {
          await publishLoaderImageItem(unit.rows[0], {
            taxonomyTree,
            findNode,
            defaultCategoryPathIds: batchDefaultPathIds,
            overwrite: batchOverwrite,
          });
        }
        published += 1;
        publishedImages += unit.rows.length;
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename) ? { ...row, status: 'done' } : row
        )));
      } catch (err) {
        failed += 1;
        await logPublishFailure({
          sku: unit.rows[0]?.code,
          filename: unit.rows.map((row) => row.filename).join(', '),
          reason: err.message,
        });
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename)
            ? { ...row, status: 'error', processError: err.message }
            : row
        )));
      } finally {
        done += 1;
        setProgress({ done, total: workUnits.length, current: unit.key });
        setElapsedMs(Date.now() - start);
      }
    });

    const groupedFamilies = new Map();
    for (const row of publishedColourRows) {
      if (!groupedFamilies.has(row.positillCode)) groupedFamilies.set(row.positillCode, []);
      groupedFamilies.get(row.positillCode).push(row);
    }
    const groupingErrors = [];
    for (const [baseCode, familyRows] of groupedFamilies) {
      try {
        await syncLoaderColourVariantGroup(familyRows);
      } catch (err) {
        groupingErrors.push(`${baseCode}: ${err.message}`);
        const filenames = new Set(familyRows.map((row) => row.filename));
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename)
            ? { ...row, status: 'review', processError: `Published; grouping needs review — ${err.message}` }
            : row
        )));
      }
    }

    setStats((s) => ({ ...s, published: s.published + published, failed: s.failed + failed }));
    setProgress({ done: workUnits.length, total: workUnits.length, current: '' });
    setElapsedMs(Date.now() - start);
    setProcessing(false);
    if (!failed && !groupingErrors.length) {
      clearDraftIfEveryRowFinished(new Set(ready.map((row) => row.filename)));
    }
    onShowToast?.(
      `Published ${published} product variant${published === 1 ? '' : 's'} from ${publishedImages} image${publishedImages === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}${groupingErrors.length ? `; ${groupingErrors.length} family group needs review` : ''}`,
      failed || groupingErrors.length ? 'warning' : 'success',
    );
  };

  const retryFailed = async () => {
    const failed = items.filter((i) => i.status === 'error');
    await publishItems(failed);
  };

  // Same rule as the Nutstore flow: images whose code has no match still go
  // to the archive as placeholders; fixing the code later re-links the data.
  const archiveItems = async (targetItems) => {
    const rows = targetItems.filter((i) => i.file && i.code && !i.parseError);
    if (!rows.length) return;
    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    setProgress({ done: 0, total: rows.length, current: '' });
    let archived = 0;
    let failed = 0;
    let done = 0;
    await runWithConcurrency(rows, FOLDER_CONCURRENCY, async (row) => {
      setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'processing' } : r)));
      try {
        await archiveLoaderImageItem(row);
        archived += 1;
        setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'archived' } : r)));
      } catch (err) {
        failed += 1;
        setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'error', processError: err.message } : r)));
      } finally {
        done += 1;
        setProgress({ done, total: rows.length, current: row.filename });
        setElapsedMs(Date.now() - start);
      }
    });
    setProgress({ done: rows.length, total: rows.length, current: '' });
    setElapsedMs(Date.now() - start);
    setProcessing(false);
    setStats((s) => ({ ...s, dormant: s.dormant + archived, failed: s.failed + failed }));
    if (!failed) clearDraftIfEveryRowFinished(new Set(rows.map((row) => row.filename)));
    onShowToast?.(`Archived ${archived}${failed ? `, ${failed} failed` : ''}`, failed ? 'warning' : 'success');
  };

  const exportReport = () => {
    const csv = exportBatchReportCsv(items, summary);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `product-loader-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderGroup = (key) => {
    const rows = grouped[key];
    if (!rows.length) return null;
    return (
      <section key={key} className="pl-folder-group">
        <h4>{GROUP_LABELS[key]} <span className="adm-muted">({rows.length})</span></h4>
        <div className="pl-folder-table-wrap">
          <table className="pl-folder-table">
            <colgroup>
              <col style={{ width: 48 }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: 88 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Preview</th>
                <th>SKU</th>
                <th>Positill / Colour</th>
                <th>Description</th>
                <th>Price incl. VAT</th>
                <th>Slot</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.filename}>
                  <td>{row.previewUrl ? <img src={row.previewUrl} alt="" className="pl-folder-thumb" /> : '—'}</td>
                  <td className="pl-table-clip"><LoaderCodeEllipsis value={loaderCodeLabel(row)} fill /></td>
                  <td className="pl-table-clip">
                    {row.isColourVariant ? (
                      <span>{row.positillCode}<br /><strong>{row.variantLabel}</strong></span>
                    ) : '—'}
                  </td>
                  <td className="pl-table-clip">
                    <LoaderCodeEllipsis value={catalogueDisplayTitle(row)} strong={false} fill />
                  </td>
                  <td>R {Number(row.price || 0).toFixed(2)}<br /><span className="adm-muted">{row.priceSourceLabel || loaderPriceSourceLabel(row.priceSource)}</span></td>
                  <td>{row.imageSlot}</td>
                  <td className={row.status === 'error' ? 'pl-error' : ''}>{rowStatusLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const busy = scanning || processing;

  return (
    <div className="pl-section">
      <p className="pl-section-note">
        Upload a single image or a whole folder of supplier images. Each filename is parsed as a
        product code and looked up automatically via the bridge. Recognised colour suffixes create
        website variants under one Positill product; for example, 8621000002-WHT becomes White.
      </p>

      <div className="pl-action-row">
        <button type="button" className="adm-btn-red" disabled={busy} onClick={() => !busy && filesRef.current?.click()}>
          {scanning ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />} Choose image(s)
        </button>
        <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => !busy && folderRef.current?.click()}>
          <FolderOpen size={16} /> Choose image folder
        </button>
        {onProcessFiles && sourceFiles.length > 0 && (
          <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => onProcessFiles(sourceFiles)}>
            <Sparkles size={14} /> Improve selected ({sourceFiles.length})
          </button>
        )}
        <input ref={filesRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
        <input ref={folderRef} type="file" accept="image/*" multiple webkitdirectory="" directory="" hidden onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
        <label className="pl-check">
          <input
            type="checkbox"
            checked={groupColourVariants}
            disabled={busy}
            onChange={(event) => setGroupColourVariants(event.target.checked)}
          />
          Group recognised colour suffixes as variants
        </label>
      </div>

      {error && <p className="pl-error">{error}</p>}

      {!items.length && draftRecovery?.count > 0 && (
        <div className="pl-draft-notice">
          <strong>Upload draft saved in this browser</strong>
          <span>{draftRecovery.count} image{draftRecovery.count === 1 ? '' : 's'} were selected before refresh; it was never published. Choose the file again to continue.</span>
          <button type="button" className="adm-btn-ghost" onClick={discardDraft}>Discard draft</button>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="pl-summary-dashboard">
            <div><strong>{summary.found}</strong><span>Images Found</span></div>
            <div><strong>{summary.matched}</strong><span>Matched</span></div>
            <div><strong>{new Set(items.filter((item) => item.isColourVariant).map((item) => item.code)).size}</strong><span>Colour Variants</span></div>
            <div><strong>{summary.published}</strong><span>Published</span></div>
            <div><strong>{summary.dormant}</strong><span>Dormant</span></div>
            <div><strong>{summary.needsReview}</strong><span>Needs Review</span></div>
            <div><strong>{summary.notFound}</strong><span>Not Found</span></div>
            <div><strong>{elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : '—'}</strong><span>Elapsed</span></div>
          </div>

          {processing && (
            <div className="pl-progress">
              <div className="pl-progress-bar" style={{ width: `${pct}%` }} />
              <span>Processing {Math.min(progress.done + 1, progress.total)}/{progress.total}{progress.current ? ` — ${progress.current}` : ''}</span>
            </div>
          )}

          {renderGroup('ready')}
          {renderGroup('needs_review')}
          {renderGroup('not_found')}

          <div className="pl-inline-fields">
            <CategoryPathSelect
              taxonomyTree={taxonomyTree}
              value={batchDefaultPathIds}
              onChange={setBatchDefaultPathIds}
              mainLabel="Default category (new products)"
            />
            <label className="pl-check">
              <input type="checkbox" checked={batchOverwrite} onChange={(e) => setBatchOverwrite(e.target.checked)} />
              Replace images if slot already filled
            </label>
          </div>

          <div className="pl-action-row">
            <button type="button" className="adm-btn-red" disabled={processing || scanning || !grouped.ready.length} onClick={() => void publishItems(grouped.ready)}>
              {processing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              Publish All Ready ({grouped.ready.length})
            </button>
            <button
              type="button"
              className="adm-btn-ghost"
              disabled={processing || scanning || !grouped.needs_review.length}
              onClick={() => void publishItems(grouped.needs_review)}
              title="Publish after reviewing warnings such as an existing image or zero stock"
            >
              <Upload size={14} /> Publish Reviewed ({grouped.needs_review.length})
            </button>
            <button
              type="button"
              className="adm-btn-ghost"
              disabled={processing || scanning || !items.some((i) => !isDraftRowFinished(i) && i.file && i.code && !i.parseError)}
              onClick={() => void archiveItems(items.filter((i) => i.status !== 'done' && i.status !== 'archived'))}
            >
              <Archive size={14} /> Send All to Archive (incl. not found)
            </button>
            <button type="button" className="adm-btn-ghost" disabled={processing || !items.some((i) => i.status === 'error')} onClick={() => void retryFailed()}>
              <RefreshCw size={14} /> Retry Failed
            </button>
            <button type="button" className="adm-btn-ghost" onClick={exportReport}>
              <Download size={14} /> Export Report
            </button>
          </div>
        </>
      )}
    </div>
  );
}
