import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  ImagePlus,
  Loader2,
  Search,
  Upload,
} from 'lucide-react';
import SectionErrorBoundary from './SectionErrorBoundary';
import DescriptionReplacePanel from './DescriptionReplacePanel';
import { buildCatalogParams, useCatalogQuery } from '../hooks/useCatalog';
import {
  BULK_IMAGE_REPLACE_MAX,
  buildPreflightMatch,
  catalogRowToSelection,
  downloadFailedCsv,
  replaceBatch,
  slotFilenameExample,
} from '../lib/bulkImageReplace';

const STEPS = ['select', 'slot', 'preflight', 'run'];

function StepTabs({ step }) {
  const idx = STEPS.indexOf(step);
  const labels = ['1. Select products', '2. Image slot', '3. Match folder', '4. Replace'];
  return (
    <div className="bir-steps" role="tablist" aria-label="Wizard steps">
      {labels.map((label, i) => (
        <span
          key={label}
          className={`bir-step${i === idx ? ' bir-step--active' : ''}${i < idx ? ' bir-step--done' : ''}`}
        >
          {i < idx ? <Check size={12} /> : null}
          {label}
        </span>
      ))}
    </div>
  );
}

function BulkImageReplacePanelInner({ taxonomyTree = [], onShowToast, titleOnly = false }) {
  const folderRef = useRef(null);
  const abortRef = useRef(false);

  const [mode, setMode] = useState(titleOnly ? 'descriptions' : 'images'); // 'images' | 'descriptions'
  const [step, setStep] = useState('select');
  const [scope, setScope] = useState('live');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [selectedMap, setSelectedMap] = useState(() => new Map());
  const [imageSlot, setImageSlot] = useState(1);
  const [preflight, setPreflight] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [runResults, setRunResults] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryId]);

  const categoryPath = useMemo(
    () => (categoryId ? [categoryId] : []),
    [categoryId],
  );

  const catalogParams = useMemo(() => buildCatalogParams({
    status: scope === 'archived' ? 'archived' : 'live',
    page,
    pageSize: 50,
    search: debouncedSearch,
    categoryPath,
    onlyInStock: false,
  }), [scope, page, debouncedSearch, categoryPath]);

  const pickerQuery = useCatalogQuery(catalogParams, { enabled: step === 'select' });
  const pickerRows = pickerQuery.data?.rows || [];
  const pickerTotal = pickerQuery.data?.total || 0;

  const mainCategories = useMemo(
    () => (taxonomyTree || []).filter((c) => c.id !== 'mottaro'),
    [taxonomyTree],
  );

  const selectedProducts = useMemo(
    () => [...selectedMap.values()],
    [selectedMap],
  );

  const selectedSkuSet = useMemo(
    () => new Set(selectedProducts.map((p) => p.sku)),
    [selectedProducts],
  );

  const toggleProduct = useCallback((row, checked) => {
    const sku = String(row.sku || '').trim().toUpperCase();
    if (!sku) return;
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (checked) {
        if (next.size >= BULK_IMAGE_REPLACE_MAX && !next.has(sku)) {
          onShowToast?.(`Maximum ${BULK_IMAGE_REPLACE_MAX} products per run`, 'error');
          return prev;
        }
        next.set(sku, catalogRowToSelection(row));
      } else {
        next.delete(sku);
      }
      return next;
    });
  }, [onShowToast]);

  // Anchor for shift-click range selection within the current page of cards.
  const lastPickIndexRef = useRef(null);

  const handlePickClick = useCallback((e, index) => {
    const anchor = lastPickIndexRef.current;
    const row = pickerRows[index];
    if (!row) return;
    const sku = String(row.sku || '').trim().toUpperCase();
    if (e.shiftKey && anchor != null && anchor !== index) {
      e.preventDefault(); // suppress the browser's shift text-selection
      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      setSelectedMap((prev) => {
        const next = new Map(prev);
        let hitCap = false;
        for (let i = start; i <= end; i += 1) {
          const r = pickerRows[i];
          const s = String(r?.sku || '').trim().toUpperCase();
          if (!s || next.has(s)) continue;
          if (next.size >= BULK_IMAGE_REPLACE_MAX) { hitCap = true; break; }
          next.set(s, catalogRowToSelection(r));
        }
        if (hitCap) onShowToast?.(`Maximum ${BULK_IMAGE_REPLACE_MAX} products per run`, 'error');
        return next;
      });
      // Anchor stays put so further shift-clicks keep extending from it.
    } else {
      toggleProduct(row, !selectedSkuSet.has(sku));
      lastPickIndexRef.current = index;
    }
  }, [pickerRows, selectedSkuSet, toggleProduct, onShowToast]);

  // The anchor is a page-relative index; reset it whenever the visible set changes.
  useEffect(() => { lastPickIndexRef.current = null; }, [page, debouncedSearch, categoryId, scope]);

  const clearSelection = useCallback(() => {
    setSelectedMap(new Map());
  }, []);

  // Live and archived products live in different tables server-side, so a
  // single run must never mix the two scopes.
  const switchScope = useCallback((next) => {
    setScope((prev) => {
      if (prev === next) return prev;
      setSelectedMap(new Map());
      setPage(1);
      return next;
    });
  }, []);

  const handleFolder = useCallback((fileList) => {
    const files = [...(fileList || [])];
    const match = buildPreflightMatch(selectedProducts, imageSlot, files);
    setPreflight({ ...match, files });
    onShowToast?.(
      `${match.readyCount} ready · ${match.missingCount} missing`,
      match.readyCount ? 'success' : 'warning',
    );
  }, [selectedProducts, imageSlot, onShowToast]);

  const startReplace = useCallback(async () => {
    if (!preflight?.ready?.length) return;
    if (!window.confirm(`Replace image ${imageSlot} for ${preflight.ready.length} product(s)?`)) return;

    abortRef.current = false;
    setRunning(true);
    setRunResults(null);
    setProgress({ done: 0, total: preflight.ready.length, phase: 'uploading' });

    try {
      const allowedSkus = selectedProducts.map((p) => p.sku);
      const results = await replaceBatch({
        slot: imageSlot,
        scope,
        allowedSkus,
        readyItems: preflight.ready,
        onProgress: setProgress,
        abortRef,
      });
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      setRunResults(results);
      onShowToast?.(
        `Replaced ${ok} image(s)${fail ? `, ${fail} failed` : ''}`,
        fail ? 'warning' : 'success',
      );
      setStep('run');
    } catch (err) {
      onShowToast?.(err.message || 'Replace failed', 'error');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [preflight, imageSlot, scope, selectedProducts, onShowToast]);

  const resetWizard = useCallback(() => {
    abortRef.current = false;
    setStep('select');
    setPreflight(null);
    setRunResults(null);
    setProgress(null);
    setRunning(false);
  }, []);

  const retryFailed = useCallback(async () => {
    const failedSkus = new Set((runResults || []).filter((r) => !r.ok).map((r) => r.sku));
    if (!failedSkus.size || !preflight?.ready?.length) return;
    const retryReady = preflight.ready.filter((r) => failedSkus.has(r.sku));
    abortRef.current = false;
    setRunning(true);
    setProgress({ done: 0, total: retryReady.length, phase: 'uploading' });
    try {
      const results = await replaceBatch({
        slot: imageSlot,
        scope,
        allowedSkus: selectedProducts.map((p) => p.sku),
        readyItems: retryReady,
        onProgress: setProgress,
        abortRef,
      });
      setRunResults((prev) => {
        const bySku = new Map((prev || []).map((r) => [r.sku, r]));
        for (const row of results) bySku.set(row.sku, row);
        return [...bySku.values()];
      });
      const ok = results.filter((r) => r.ok).length;
      onShowToast?.(`Retry: ${ok} succeeded`, ok ? 'success' : 'warning');
    } catch (err) {
      onShowToast?.(err.message || 'Retry failed', 'error');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [runResults, preflight, imageSlot, scope, selectedProducts, onShowToast]);

  const slotsRemaining = Math.max(0, BULK_IMAGE_REPLACE_MAX - selectedProducts.length);

  return (
    <div className="adm-panel bir-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ImagePlus size={20} />
            {mode === 'descriptions' ? 'Title Replace' : 'Image Replace'}
          </h2>
          <p className="adm-section-note">
            {mode === 'descriptions'
              ? 'Bulk-replace product titles from a barcode spreadsheet.'
              : `Select up to ${BULK_IMAGE_REPLACE_MAX} ${scope === 'archived' ? 'archived' : 'live'} products, pick one image slot, then upload a folder of replacement images.`}
          </p>
        </div>
      </div>

      {!titleOnly && <div className="adm-tabbar" role="tablist" aria-label="Replace mode" style={{ display: 'inline-flex', gap: 4, marginBottom: 14 }}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'images'}
          className={mode === 'images' ? 'adm-btn-red adm-btn--sm' : 'adm-btn-ghost adm-btn--sm'}
          onClick={() => setMode('images')}
        >
          Images
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'descriptions'}
          className={mode === 'descriptions' ? 'adm-btn-red adm-btn--sm' : 'adm-btn-ghost adm-btn--sm'}
          onClick={() => setMode('descriptions')}
        >
          Titles
        </button>
      </div>}

      {mode === 'descriptions' && <DescriptionReplacePanel onShowToast={onShowToast} />}

      {mode === 'images' && (
      <>
      <StepTabs step={step} />

      {step === 'select' && (
        <>
          <div className="adm-toolbar pm-toolbar" style={{ marginBottom: 12 }}>
            <div className="adm-tabbar" role="tablist" aria-label="Product scope" style={{ display: 'inline-flex', gap: 4 }}>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'live'}
                className={scope === 'live' ? 'adm-btn-red adm-btn--sm' : 'adm-btn-ghost adm-btn--sm'}
                onClick={() => switchScope('live')}
              >
                Live products
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'archived'}
                className={scope === 'archived' ? 'adm-btn-red adm-btn--sm' : 'adm-btn-ghost adm-btn--sm'}
                onClick={() => switchScope('archived')}
              >
                Archived products
              </button>
            </div>
            <label className="adm-search" style={{ flex: 1, minWidth: 200 }}>
              <Search size={15} />
              <input
                type="search"
                className="adm-search-input"
                placeholder="Search SKU, title…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </label>
            <select
              className="adm-select adm-select--enhanced"
              value={categoryId}
              onChange={(e) => { setCategoryId(e.target.value); setPage(1); }}
              style={{ minWidth: 180 }}
            >
              <option value="">All categories</option>
              {mainCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={clearSelection} disabled={!selectedProducts.length}>
              Clear
            </button>
            <span className="adm-pill" style={{ fontSize: 12 }}>
              {selectedProducts.length} selected · {slotsRemaining} remaining
            </span>
          </div>

          {pickerQuery.isLoading && !pickerQuery.data ? (
            <p className="adm-section-note"><Loader2 size={14} className="spin" /> Loading products…</p>
          ) : (
            <>
              <p className="adm-muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
                Click to select · <strong>Shift+click</strong> another card to select the range between them.
              </p>
              <div className="bir-pick-grid">
                {pickerRows.map((row, index) => {
                  const product = catalogRowToSelection(row);
                  const checked = selectedSkuSet.has(product.sku);
                  return (
                    <div
                      key={product.sku}
                      role="button"
                      tabIndex={0}
                      className={`bir-pick-card${checked ? ' bir-pick-card--selected' : ''}`}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      onClick={(e) => handlePickClick(e, index)}
                      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handlePickClick(e, index); } }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        readOnly
                        tabIndex={-1}
                        style={{ pointerEvents: 'none' }}
                      />
                      <div className="adm-product-thumb bir-pick-thumb">
                        {product.images[0]
                          ? <img src={product.images[0]} alt="" loading="lazy" decoding="async" />
                          : <span className="adm-muted">IMG</span>}
                      </div>
                      <div className="bir-pick-meta">
                        <strong>{product.title}</strong>
                        <div className="adm-muted" style={{ fontSize: 11 }}>{product.sku}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {pickerRows.length === 0 && (
                <p className="adm-section-note">No products match your search.</p>
              )}
              {pickerTotal > 50 && (
                <div className="adm-toolbar" style={{ marginTop: 12, justifyContent: 'center', gap: 8 }}>
                  <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
                  <span className="adm-muted" style={{ fontSize: 12 }}>Page {page} of {Math.max(1, Math.ceil(pickerTotal / 50))}</span>
                  <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={page >= Math.ceil(pickerTotal / 50)} onClick={() => setPage((p) => p + 1)}>Next</button>
                </div>
              )}
            </>
          )}

          <div className="bir-wizard-nav">
            <span />
            <button
              type="button"
              className="adm-btn-red adm-btn--sm"
              disabled={!selectedProducts.length}
              onClick={() => setStep('slot')}
            >
              Next <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}

      {step === 'slot' && (
        <>
          <p className="adm-section-note">
            {selectedProducts.length} product(s) selected. Choose which image slot you are replacing.
          </p>
          <div className="bir-slot-picker">
            {[1, 2, 3, 4].map((slot) => (
              <label key={slot} className={`bir-slot-option${imageSlot === slot ? ' bir-slot-option--active' : ''}`}>
                <input
                  type="radio"
                  name="imageSlot"
                  checked={imageSlot === slot}
                  onChange={() => setImageSlot(slot)}
                />
                <strong>Image {slot}</strong>
                <span className="adm-muted" style={{ fontSize: 11 }}>
                  e.g. {slotFilenameExample('BASHEWS', slot)}
                </span>
              </label>
            ))}
          </div>

          <div className="bir-review-scroll">
            {selectedProducts.slice(0, 100).map((p) => (
              <div key={p.sku} className="bir-review-row">
                <div className="adm-product-thumb bir-pick-thumb">
                  {p.images[imageSlot - 1]
                    ? <img src={p.images[imageSlot - 1]} alt="" loading="lazy" />
                    : <span className="adm-muted">—</span>}
                </div>
                <div>
                  <strong style={{ fontSize: 13 }}>{p.title}</strong>
                  <div className="adm-muted" style={{ fontSize: 11 }}>{p.sku}</div>
                </div>
              </div>
            ))}
            {selectedProducts.length > 100 && (
              <p className="adm-muted" style={{ fontSize: 12, marginTop: 8 }}>
                + {selectedProducts.length - 100} more products (not shown)
              </p>
            )}
          </div>

          <div className="bir-wizard-nav">
            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => setStep('select')}>
              <ArrowLeft size={14} /> Back
            </button>
            <button type="button" className="adm-btn-red adm-btn--sm" onClick={() => { setPreflight(null); setStep('preflight'); }}>
              Next <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}

      {step === 'preflight' && (
        <>
          <p className="adm-section-note">
            Upload a folder for <strong>image {imageSlot}</strong>.
            Files must be named like <code>{slotFilenameExample('BASHEWS', imageSlot)}</code>.
            Missing files are OK — only matched products will be updated.
          </p>
          <label className="adm-btn-ghost" style={{ display: 'inline-flex', gap: 8, cursor: 'pointer' }}>
            <FolderOpen size={15} />
            Choose image folder
            <input
              ref={folderRef}
              type="file"
              accept="image/*"
              multiple
              webkitdirectory=""
              directory=""
              hidden
              onChange={(e) => { handleFolder(e.target.files); e.target.value = ''; }}
            />
          </label>

          {preflight && (
            <>
              <div className="bir-preflight-stats">
                <span className="bir-stat bir-stat--ok">{preflight.readyCount} ready</span>
                <span className="bir-stat bir-stat--warn">{preflight.missingCount} missing</span>
                {preflight.wrongSlot.length > 0 && (
                  <span className="bir-stat bir-stat--bad">{preflight.wrongSlot.length} wrong slot</span>
                )}
                {preflight.extra.length > 0 && (
                  <span className="bir-stat">{preflight.extra.length} extra (ignored)</span>
                )}
              </div>

              {preflight.readyCount > 0 && (
                <p className="adm-section-note" style={{ color: '#15803d' }}>
                  {preflight.readyCount} product(s) will be updated. {preflight.missingCount} selected product(s) have no matching file and will be skipped.
                </p>
              )}

              {progress && (
                <div className="bir-progress">
                  <Loader2 size={14} className="spin" />
                  <span>Replacing {progress.done} / {progress.total}…</span>
                </div>
              )}
            </>
          )}

          <div className="bir-wizard-nav">
            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => setStep('slot')} disabled={running}>
              <ArrowLeft size={14} /> Back
            </button>
            <button
              type="button"
              className="adm-btn-red adm-btn--sm"
              disabled={running || !preflight?.readyCount}
              onClick={() => void startReplace()}
            >
              {running ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              Replace {preflight?.readyCount || 0} image(s)
            </button>
          </div>
        </>
      )}

      {step === 'run' && runResults && (
        <>
          {(() => {
            const ok = runResults.filter((r) => r.ok).length;
            const fail = runResults.filter((r) => !r.ok).length;
            return (
              <p className="adm-section-note">
                Done: <strong>{ok} replaced</strong>
                {fail > 0 && <>, <strong style={{ color: '#b45309' }}>{fail} failed</strong></>}
              </p>
            );
          })()}

          {runResults.filter((r) => !r.ok).length > 0 && (
            <div className="bir-wizard-nav" style={{ marginBottom: 12 }}>
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => void retryFailed()} disabled={running}>
                Retry failed
              </button>
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => downloadFailedCsv(runResults)}>
                Download failed CSV
              </button>
            </div>
          )}

          <p className="adm-section-note" style={{ marginBottom: 8 }}>
            Previews below show the new image now on each product — confirm the change before running again.
          </p>
          <div className="bir-review-scroll">
            {runResults.slice(0, 200).map((r) => (
              <div key={r.sku} className="bir-review-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {r.ok && r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ lineHeight: 0 }}>
                    <img
                      src={r.url}
                      alt={r.sku}
                      width={44}
                      height={44}
                      style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f8fafc' }}
                    />
                  </a>
                ) : (
                  <span style={{ width: 44, height: 44, borderRadius: 6, border: '1px solid #fee2e2', background: '#fef2f2', display: 'inline-block' }} />
                )}
                <code style={{ fontSize: 12, minWidth: 100 }}>{r.sku}</code>
                {r.ok
                  ? <span style={{ color: '#15803d', fontWeight: 700, fontSize: 12 }}>Replaced</span>
                  : <span style={{ color: '#b91c1c', fontSize: 12 }}>{r.error || 'Failed'}</span>}
              </div>
            ))}
          </div>

          <div className="bir-wizard-nav">
            <button type="button" className="adm-btn-red adm-btn--sm" onClick={resetWizard}>
              Start new run
            </button>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}

export default function BulkImageReplacePanel(props) {
  return (
    <SectionErrorBoundary name="image-replace" title="Image Replace crashed">
      <BulkImageReplacePanelInner {...props} />
    </SectionErrorBoundary>
  );
}
