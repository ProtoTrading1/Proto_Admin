import { useCallback, useRef, useState } from 'react';
import { Check, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import {
  applyDescriptions,
  downloadUnmatchedCsv,
  parseDescriptionSheet,
  previewDescriptions,
} from '../lib/bulkDescriptionReplace';

export default function DescriptionReplacePanel({ onShowToast }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState(null); // preview rows
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState(null);

  const reset = useCallback(() => {
    setFileName('');
    setRows(null);
    setResults(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setParsing(true);
    setResults(null);
    setRows(null);
    setFileName(file.name);
    try {
      const items = await parseDescriptionSheet(file);
      const preview = await previewDescriptions(items);
      setRows(preview);
      const found = preview.filter((r) => r.found).length;
      onShowToast?.(`${found} matched · ${preview.length - found} not found`, found ? 'success' : 'warning');
    } catch (err) {
      onShowToast?.(err.message || 'Could not read that file', 'error');
      reset();
    } finally {
      setParsing(false);
    }
  }, [onShowToast, reset]);

  const applicable = (rows || []).filter((r) => r.found && !r.unchanged);

  const runApply = useCallback(async () => {
    if (!applicable.length) return;
    if (!window.confirm(`Replace titles for ${applicable.length} product(s)?`)) return;
    setApplying(true);
    try {
      const res = await applyDescriptions(applicable.map((r) => ({ sku: r.sku, title: r.newTitle })));
      setResults(res);
      onShowToast?.(
        `Updated ${res.updated}${res.notFound ? `, ${res.notFound} not found` : ''}${res.failed ? `, ${res.failed} failed` : ''}`,
        res.failed ? 'warning' : 'success',
      );
    } catch (err) {
      onShowToast?.(err.message || 'Update failed', 'error');
    } finally {
      setApplying(false);
    }
  }, [applicable, onShowToast]);

  const foundCount = (rows || []).filter((r) => r.found).length;
  const notFoundCount = (rows || []).filter((r) => !r.found).length;
  const unchangedCount = (rows || []).filter((r) => r.found && r.unchanged).length;

  return (
    <div>
      <p className="adm-section-note">
        Upload a spreadsheet with <strong>SKU</strong> and <strong>TITLE</strong> columns
        (a NAME/PRODUCT/DESCRIPTION header also works). Each exact SKU is matched to one live
        product and only that product&apos;s <strong>title</strong> is replaced. Barcodes are shown
        for reference but are never used to match or update products.
      </p>

      <div className="adm-toolbar" style={{ gap: 10, marginBottom: 12 }}>
        <label className="adm-btn-ghost" style={{ display: 'inline-flex', gap: 8, cursor: 'pointer' }}>
          <FileSpreadsheet size={15} />
          {fileName ? 'Choose a different file' : 'Choose spreadsheet (.xlsx / .csv)'}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            hidden
            onChange={(e) => { void handleFile(e.target.files?.[0]); }}
          />
        </label>
        {parsing && <span className="adm-section-note" style={{ margin: 0 }}><Loader2 size={14} className="spin" /> Reading…</span>}
        {fileName && !parsing && <span className="adm-pill" style={{ fontSize: 12 }}>{fileName}</span>}
        {rows && (
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={reset} disabled={applying}>Clear</button>
        )}
      </div>

      {rows && !results && (
        <>
          <div className="bir-preflight-stats" style={{ marginBottom: 12 }}>
            <span className="bir-stat bir-stat--ok">{applicable.length} to update</span>
            {unchangedCount > 0 && <span className="bir-stat">{unchangedCount} already match</span>}
            <span className="bir-stat bir-stat--warn">{notFoundCount} not found</span>
            <span className="bir-stat">{foundCount + notFoundCount} rows total</span>
          </div>

          <div className="bir-review-scroll" style={{ maxHeight: 460 }}>
            <table className="drp-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>Current title</th>
                  <th>New title</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className={!r.found ? 'drp-row--missing' : r.unchanged ? 'drp-row--same' : ''}>
                    <td><code style={{ fontSize: 11 }}>{r.sku}</code></td>
                    <td>{r.found ? (r.barcode || <span className="adm-muted">—</span>) : <span className="adm-muted">—</span>}</td>
                    <td className="drp-desc">{r.found ? (r.currentTitle || <span className="adm-muted">(empty)</span>) : <span className="adm-muted">—</span>}</td>
                    <td className="drp-desc">{r.newTitle}</td>
                    <td>
                      {!r.found
                        ? <span style={{ color: '#b91c1c', fontSize: 12, fontWeight: 700 }}><X size={12} /> Not found</span>
                        : r.unchanged
                          ? <span className="adm-muted" style={{ fontSize: 12 }}>No change</span>
                          : <span style={{ color: '#15803d', fontSize: 12, fontWeight: 700 }}>Will update</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 && (
              <p className="adm-muted" style={{ fontSize: 12, marginTop: 8 }}>+ {rows.length - 500} more rows (not shown, still processed)</p>
            )}
          </div>

          <div className="bir-wizard-nav" style={{ marginTop: 12 }}>
            {notFoundCount > 0 && (
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => downloadUnmatchedCsv(rows)}>
                Download unmatched CSV
              </button>
            )}
            <button
              type="button"
              className="adm-btn-red adm-btn--sm"
              disabled={applying || !applicable.length}
              onClick={() => void runApply()}
              style={{ marginLeft: 'auto' }}
            >
              {applying ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              Replace {applicable.length} title(s)
            </button>
          </div>
        </>
      )}

      {results && (
        <>
          <p className="adm-section-note">
            <Check size={14} style={{ color: '#15803d' }} /> Done: <strong>{results.updated} updated</strong>
            {results.notFound > 0 && <>, {results.notFound} not found</>}
            {results.failed > 0 && <>, <strong style={{ color: '#b45309' }}>{results.failed} failed</strong></>}
          </p>
          <div className="bir-wizard-nav">
            <button type="button" className="adm-btn-red adm-btn--sm" onClick={reset}>Start new run</button>
          </div>
        </>
      )}
    </div>
  );
}
