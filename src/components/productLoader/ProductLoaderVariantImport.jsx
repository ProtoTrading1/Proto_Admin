import { useMemo, useRef, useState } from 'react';
import { Archive, CheckCircle, FileSpreadsheet, FolderOpen, Loader2, ShieldAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { archiveVariantProduct, uploadProductImageSlot } from '../../lib/productLoaderApi';
import {
  isExistingExcelArchiveRow,
  matchVariantImages,
  parseVariantImportSheet,
  variantRowState,
} from '../../lib/productVariantImport';
import { readApiJson } from '../../lib/apiError';
import { queryKeys } from '../../lib/queryKeys';
import { saveArchivePrioritySkus } from '../../../lib/archive-priority.mjs';

export default function ProductLoaderVariantImport({ publishedBy = '', onShowToast }) {
  const queryClient = useQueryClient();
  const sheetRef = useRef(null);
  const folderRef = useRef(null);
  const [sheetName, setSheetName] = useState('');
  const [rows, setRows] = useState([]);
  const [files, setFiles] = useState([]);
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, sku: '' });
  const [error, setError] = useState('');
  const [batchSummary, setBatchSummary] = useState('');
  const [rowResults, setRowResults] = useState({});
  const uploadedImagesRef = useRef(new Map());
  const batchIdRef = useRef('');

  const combine = (sheetRows, localFiles, previewRows = null) => {
    const matched = matchVariantImages(sheetRows, localFiles);
    const sourceBySku = new Map((previewRows || rows).map((row) => [row.sku, row]));
    setUnmatchedCount(matched.unmatched.length);
    setRows(matched.items.map((item) => ({ ...sourceBySku.get(item.sku), ...item })));
  };

  const preview = async (sheetRows, localFiles) => {
    setLoading(true);
    setError('');
    setBatchSummary('');
    setRowResults({});
    uploadedImagesRef.current.clear();
    batchIdRef.current = '';
    try {
      const res = await fetch('/api/product-loader-variant-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: sheetRows.map(({ sku, barcode }) => ({ sku, barcode })) }),
      });
      const json = await readApiJson(res, { fallback: 'Preview failed' });
      const bySku = new Map((json.rows || []).map((row) => [row.sku, row]));
      const enriched = sheetRows.map((row) => ({ ...row, ...(bySku.get(row.sku) || {}) }));
      combine(enriched, localFiles, enriched);
    } catch (err) {
      setError(err.message || 'Preview failed');
    } finally {
      setLoading(false);
    }
  };

  const chooseSheet = async (file) => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const parsed = await parseVariantImportSheet(file);
      // Keep this Excel batch at the beginning of Archive for the rest of this
      // browser session. This is display-only and does not touch stored rows.
      saveArchivePrioritySkus(parsed.map((row) => row.sku));
      setSheetName(file.name);
      await preview(parsed, files);
    } catch (err) {
      setRows([]);
      setError(err.message || 'Could not read the spreadsheet');
      setLoading(false);
    }
  };

  const chooseFolder = (selected) => {
    const localFiles = Array.from(selected || []);
    setFiles(localFiles);
    if (rows.length) combine(rows, localFiles);
  };

  const readyRows = useMemo(
    () => rows.filter((row) => variantRowState(row).ready),
    [rows],
  );
  const pendingRows = useMemo(
    () => readyRows.filter((row) => rowResults[row.sku]?.status !== 'success'),
    [readyRows, rowResults],
  );

  const refreshArchive = async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'catalog' && query.queryKey[1]?.status === 'archived',
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() }),
    ]);
    try {
      localStorage.setItem('proto-catalog-mutated-at', String(Date.now()));
    } catch { /* another tab can still refresh on focus */ }
    window.dispatchEvent(new CustomEvent('proto-catalog-mutated'));
  };

  const archive = async () => {
    if (!pendingRows.length) return;
    const confirmed = window.confirm(
      `Send ${pendingRows.length} product${pendingRows.length === 1 ? '' : 's'} to Archive? They will stay off the website until each product's category is selected and Make live is confirmed.`,
    );
    if (!confirmed) return;

    setPublishing(true);
    setError('');
    setBatchSummary('');
    setProgress({ done: 0, total: pendingRows.length, sku: '' });
    if (!batchIdRef.current) {
      batchIdRef.current = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    // Keep one batch marker across retries so all successful rows stay grouped
    // together at the beginning of Archive.
    const batchId = batchIdRef.current;
    let succeededCount = 0;
    let failedCount = 0;

    for (let index = 0; index < pendingRows.length; index += 1) {
      const row = pendingRows[index];
      setProgress({ done: index, total: pendingRows.length, sku: row.sku });
      setRowResults((current) => ({
        ...current,
        [row.sku]: { status: 'processing', message: 'Uploading images…' },
      }));
      try {
        const includeExistingInBatch = isExistingExcelArchiveRow(row);
        const cachedImages = uploadedImagesRef.current.get(row.sku) || new Map();
        if (!includeExistingInBatch) {
          for (const image of row.images) {
            if (cachedImages.has(image.slot)) continue;
            const uploaded = await uploadProductImageSlot({
              file: image.file,
              sku: row.sku,
              slot: image.slot,
              requireNew: true,
            });
            cachedImages.set(image.slot, uploaded.url);
            uploadedImagesRef.current.set(row.sku, cachedImages);
          }
        }
        const result = await archiveVariantProduct({
          code: row.sku,
          barcode: row.barcode,
          title: row.title,
          description: row.title,
          price: row.price,
          stockQty: row.stockQty,
          availableStock: row.availableStock,
          unitsOfIssue: row.unitsOfIssue || 'EACH',
          images: [...cachedImages.entries()].map(([slot, url]) => ({ slot, url })),
          publishedBy,
          batchId,
          includeExistingInBatch,
        });
        succeededCount += 1;
        setRowResults((current) => ({
          ...current,
          [row.sku]: {
            status: 'success',
            message: result.action === 'included'
              ? 'Included in this batch; existing images unchanged'
              : 'Sent to Archive',
          },
        }));
      } catch (err) {
        failedCount += 1;
        setRowResults((current) => ({
          ...current,
          [row.sku]: {
            status: 'failed',
            message: err.message || 'Could not send this row to Archive',
          },
        }));
      }
      setProgress({ done: index + 1, total: pendingRows.length, sku: row.sku });
    }

    if (succeededCount) {
      await refreshArchive();
    }
    const summary = `${succeededCount} sent to Archive${failedCount ? `, ${failedCount} failed and can be retried` : ''}.`;
    setBatchSummary(summary);
    onShowToast?.(summary, failedCount ? 'warning' : 'success');
    setPublishing(false);
  };

  const blocked = rows.length - readyRows.length;
  const succeeded = Object.values(rowResults).filter((result) => result.status === 'success').length;
  const failed = Object.values(rowResults).filter((result) => result.status === 'failed').length;

  return (
    <div>
      <div style={{ padding: 12, marginBottom: 16, border: '1px solid #bfdbfe', borderRadius: 10, background: '#eff6ff', color: '#1e3a8a', fontSize: 13 }}>
        Upload the SKU/barcode/title Excel, then choose the local image folder. Several SKUs may share one barcode; each SKU keeps its own title and images. Ready rows go to Archive, not the live website.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button" className="adm-btn-secondary" onClick={() => sheetRef.current?.click()} disabled={loading || publishing}>
          <FileSpreadsheet size={15} /> {sheetName || 'Choose Excel'}
        </button>
        <button type="button" className="adm-btn-secondary" onClick={() => folderRef.current?.click()} disabled={!rows.length || loading || publishing}>
          <FolderOpen size={15} /> {files.length ? `${files.length} local files selected` : 'Choose image folder'}
        </button>
        <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => chooseSheet(e.target.files?.[0])} />
        <input ref={folderRef} type="file" accept="image/*" multiple webkitdirectory="" directory="" hidden onChange={(e) => chooseFolder(e.target.files)} />
      </div>

      {loading && <p className="adm-muted"><Loader2 size={14} className="spin" /> Checking exact SKUs and Positill barcodes…</p>}
      {error && <div style={{ padding: 10, marginBottom: 14, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      {batchSummary && <div style={{ padding: 10, marginBottom: 14, border: `1px solid ${failed ? '#fed7aa' : '#bbf7d0'}`, borderRadius: 8, background: failed ? '#fff7ed' : '#f0fdf4', color: failed ? '#9a3412' : '#166534', fontSize: 13, fontWeight: 700 }}>{batchSummary}</div>}

      {rows.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 13 }}>
            <span style={{ color: '#15803d', fontWeight: 700 }}><CheckCircle size={14} /> {Math.max(0, pendingRows.length - failed)} ready</span>
            {succeeded > 0 && <span style={{ color: '#166534', fontWeight: 700 }}><CheckCircle size={14} /> {succeeded} sent</span>}
            {failed > 0 && <span style={{ color: '#b91c1c', fontWeight: 700 }}><ShieldAlert size={14} /> {failed} failed</span>}
            <span style={{ color: blocked ? '#b91c1c' : '#64748b', fontWeight: 700 }}><ShieldAlert size={14} /> {blocked} blocked</span>
            {unmatchedCount > 0 && <span className="adm-muted">{unmatchedCount} folder files unmatched</span>}
          </div>

          <div style={{ overflowX: 'auto', maxHeight: 440, border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 16 }}>
            <table className="adm-table" style={{ width: '100%' }}>
              <thead><tr><th>SKU</th><th>Barcode</th><th>Website title</th><th>Images</th><th>Status</th></tr></thead>
              <tbody>{rows.map((row) => {
                const state = variantRowState(row);
                const result = rowResults[row.sku];
                const resultFailed = result?.status === 'failed';
                return (
                  <tr key={row.sku} style={{ background: resultFailed ? '#fef2f2' : (state.ready ? '#f0fdf4' : '#fef2f2') }}>
                    <td style={{ fontWeight: 700 }}>{row.sku}</td>
                    <td>{row.barcode}</td>
                    <td>{row.title}</td>
                    <td>{row.images?.map((image) => `#${image.slot} ${image.filename}`).join(', ') || '—'}</td>
                    <td style={{ color: resultFailed || !state.ready ? '#b91c1c' : '#15803d', fontWeight: 700 }}>
                      {resultFailed ? `Failed — ${result.message}. Retry will continue with this row.` : (result?.message || state.reason)}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>

          <button type="button" className="adm-btn-red" onClick={archive} disabled={!pendingRows.length || publishing || loading}>
            {publishing ? <><Loader2 size={15} className="spin" /> {progress.done}/{progress.total} · {progress.sku}</> : <><Archive size={15} /> {failed ? `Retry ${pendingRows.length} unsent` : `Send ${pendingRows.length} to Archive`}</>}
          </button>
          <p className="adm-section-note" style={{ marginTop: 8 }}>Nothing goes live from this screen. In Product Manager → Archive, open Make live and choose the correct category and full subcategory path for each SKU.</p>
        </>
      )}
    </div>
  );
}
