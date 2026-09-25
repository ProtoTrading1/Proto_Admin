import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  FileImage,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import { readApiJson } from '../../lib/apiError.js';
import { catalogueDisplayTitle, catalogueDescription, loaderCodeLabel } from '../../lib/productLoaderDisplay.js';
import LoaderCodeEllipsis from './LoaderCodeEllipsis.jsx';
import { loaderPriceSourceLabel, loaderPriceUsesCachedData } from '../../../lib/catalogue-price.mjs';

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

function childrenOf(tree, id) {
  return findNode(tree, id)?.children || [];
}

function categoryLabelsFromIds(tree, categoryId, sub1Id) {
  const catNode = findNode(tree, categoryId);
  const sub1Node = findNode(tree, sub1Id);
  return {
    category: catNode?.label || '',
    subcategoryOne: sub1Node?.label || catNode?.label || '',
  };
}

const GROUP_LABELS = {
  ready: 'Ready',
  needs_review: 'Needs Review',
  not_found: 'Not Found',
};

const STEPS = [
  'Open a subfolder on the left (PTR Photos categories).',
  'Tick product images on the right — Positill code is the filename before the first hyphen.',
  'Click Look up selected — Positill fills price, description and stock.',
  'Publish to website (pick category below) or archive — no category needed for archive.',
];

/** Max concurrent Nutstore preview downloads. */
let thumbInFlight = 0;
const THUMB_QUEUE = [];
const THUMB_MAX = 3;
const thumbBlobCache = new Map();

function drainThumbQueue() {
  while (thumbInFlight < THUMB_MAX && THUMB_QUEUE.length) {
    const job = THUMB_QUEUE.shift();
    thumbInFlight += 1;
    job().finally(() => {
      thumbInFlight -= 1;
      drainThumbQueue();
    });
  }
}

function queueThumbLoad(run) {
  return new Promise((resolve, reject) => {
    THUMB_QUEUE.push(() => run().then(resolve, reject));
    drainThumbQueue();
  });
}

function pruneThumbCache(keepPaths) {
  const keep = keepPaths instanceof Set ? keepPaths : new Set(keepPaths);
  for (const [path, url] of thumbBlobCache) {
    if (!keep.has(path)) {
      URL.revokeObjectURL(url);
      thumbBlobCache.delete(path);
    }
  }
}

/** Lazy preview — only loads when scrolled into view, scoped to current folder. */
function FolderNutstoreThumb({ path, folderScope }) {
  const hostRef = useRef(null);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc('');
    setFailed(false);
    const el = hostRef.current;
    if (!el || !path) return undefined;

    let cancelled = false;
    const cached = thumbBlobCache.get(path);
    if (cached) {
      setSrc(cached);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (cancelled || !entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void queueThumbLoad(async () => {
        const res = await fetch(`/api/nutstore-thumbnail?path=${encodeURIComponent(path)}`);
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        thumbBlobCache.set(path, url);
        if (!cancelled) setSrc(url);
      }).catch(() => {
        if (!cancelled) setFailed(true);
      });
    }, { rootMargin: '100px', threshold: 0.01 });

    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [path, folderScope]);

  return (
    <span ref={hostRef} className="pl-nutstore-thumb-slot" aria-hidden>
      {failed ? (
        <FileImage size={16} className="pl-nutstore-image-row-icon" />
      ) : src ? (
        <img src={src} alt="" className="pl-nutstore-thumb" loading="lazy" />
      ) : (
        <span className="pl-nutstore-thumb pl-nutstore-thumb--loading" />
      )}
    </span>
  );
}

function relativeCrumbs(currentPath, libraryRoot, libraryLabel) {
  const root = libraryRoot || '/PTR-photos';
  const label = libraryLabel || 'PTR Photos';
  if (currentPath === root) {
    return [{ label, path: root }];
  }
  const crumbs = [{ label, path: root }];
  const suffix = currentPath.startsWith(`${root}/`) ? currentPath.slice(root.length + 1) : '';
  if (!suffix) return crumbs;
  let acc = root;
  for (const part of suffix.split('/').filter(Boolean)) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function parentPath(currentPath, libraryRoot) {
  const root = libraryRoot || '/PTR-photos';
  if (currentPath === root) return null;
  const parts = currentPath.split('/').filter(Boolean);
  parts.pop();
  const parent = `/${parts.join('/')}`;
  if (!parent.startsWith(root)) return root;
  return parent || root;
}

export default function ProductLoaderNutstore({
  taxonomyTree,
  batchDefaultCategoryId,
  setBatchDefaultCategoryId,
  batchDefaultSub1Id,
  setBatchDefaultSub1Id,
  batchOverwrite,
  setBatchOverwrite,
  onShowToast,
  onPublished,
  onProcessSelected,
}) {
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;

  const [status, setStatus] = useState({ loading: true, ok: false, error: '' });
  const [libraryRoot, setLibraryRoot] = useState('/PTR-photos');
  const [libraryLabel, setLibraryLabel] = useState('PTR Photos');
  const [currentPath, setCurrentPath] = useState('/PTR-photos');
  const [entries, setEntries] = useState([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [items, setItems] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [lookupStale, setLookupStale] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processAction, setProcessAction] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const resultsRef = useRef(null);

  const batchSub1Options = batchDefaultCategoryId ? childrenOf(taxonomyTree, batchDefaultCategoryId) : [];

  const breadcrumbs = useMemo(
    () => relativeCrumbs(currentPath, libraryRoot, libraryLabel),
    [currentPath, libraryRoot, libraryLabel],
  );

  const folders = useMemo(() => entries.filter((e) => e.type === 'dir'), [entries]);
  const images = useMemo(() => entries.filter((e) => e.type === 'file' && e.isImage), [entries]);
  const canGoUp = currentPath !== libraryRoot;

  const grouped = useMemo(() => ({
    ready: items.filter((i) => i.group === 'ready'),
    needs_review: items.filter((i) => i.group === 'needs_review'),
    not_found: items.filter((i) => i.group === 'not_found'),
  }), [items]);

  const selectedPaths = useMemo(() => [...selected], [selected]);
  const hasResults = items.length > 0 || scanning;
  const imagePathsInFolder = useMemo(() => images.map((e) => e.path), [images]);

  useEffect(() => {
    pruneThumbCache(new Set(imagePathsInFolder));
  }, [currentPath, imagePathsInFolder.join('|')]);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/nutstore-browse?action=status');
    const json = await readApiJson(res, { fallback: 'Nutstore status failed' });
    const root = json.libraryRoot || json.rootPath || '/PTR-photos';
    setLibraryRoot(root);
    setLibraryLabel(json.libraryLabel || 'PTR Photos');
    setCurrentPath(root);
    return root;
  }, []);

  const loadDirectory = useCallback(async (path, q = '', href = '') => {
    setBrowseLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ path });
      if (q.trim()) params.set('q', q.trim());
      if (href) params.set('href', href);
      const res = await fetch(`/api/nutstore-browse?${params}`);
      const json = await readApiJson(res, { fallback: 'Browse failed' });
      setEntries(json.entries || []);
      setCurrentPath(json.path || path);
      if (json.libraryRoot) setLibraryRoot(json.libraryRoot);
      if (json.truncated) {
        onShowToastRef.current?.('Stopped after 80 subfolders to protect Nutstore rate limits. Select images per folder instead.', 'warning');
      }
      return true;
    } catch (err) {
      setError(err.message || 'Failed to load folder');
      setEntries([]);
      return false;
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const boot = useCallback(async () => {
    setStatus({ loading: true, ok: false, error: '' });
    setError('');
    try {
      const root = await loadStatus();
      const ok = await loadDirectory(root, '');
      setStatus({
        loading: false,
        ok,
        error: ok ? '' : 'Could not load PTR Photos from Nutstore. If you see a rate-limit message below, wait a few minutes and retry.',
      });
    } catch (err) {
      setStatus({ loading: false, ok: false, error: err.message || 'Nutstore unavailable' });
    }
  }, [loadStatus, loadDirectory]);

  useEffect(() => { void boot(); }, [boot]);

  const goTo = (path, href = '') => {
    void loadDirectory(path, search, href);
  };

  const goUp = () => {
    const parent = parentPath(currentPath, libraryRoot);
    if (parent) void loadDirectory(parent, search);
  };

  const goHome = () => {
    void loadDirectory(libraryRoot, search);
  };

  const toggleSelect = (path) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setLookupStale(true);
  };

  const selectAllImagesInView = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const img of images) next.add(img.path);
      return next;
    });
    setLookupStale(true);
    onShowToastRef.current?.(`Selected ${images.length} image(s) in this folder`, 'success');
  };

  const clearSelection = () => {
    setSelected(new Set());
    setLookupStale(true);
  };

  const selectEntireFolder = async () => {
    setBrowseLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/nutstore-browse?path=${encodeURIComponent(currentPath)}&recursive=1`);
      const json = await readApiJson(res, { fallback: 'Recursive list failed' });
      const paths = (json.entries || []).map((e) => e.path);
      setSelected(new Set(paths));
      setLookupStale(true);
      onShowToastRef.current?.(`Selected ${paths.length} image(s) under this folder`, 'success');
    } catch (err) {
      setError(err.message || 'Failed to select folder');
    } finally {
      setBrowseLoading(false);
    }
  };

  const lookupSelected = async () => {
    if (!selectedPaths.length) {
      setError('Select one or more images first.');
      return;
    }
    setScanning(true);
    setLookupStale(false);
    setError('');
    try {
      const res = await fetch('/api/nutstore-batch-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: selectedPaths }),
      });
      const json = await readApiJson(res, { fallback: 'Lookup failed' });
      setItems(json.items || []);
      const ready = (json.items || []).filter((i) => i.group === 'ready').length;
      onShowToastRef.current?.(`Looked up ${json.items?.length || 0} — ${ready} ready`, 'success');
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } catch (err) {
      setError(err.message || 'Lookup failed');
    } finally {
      setScanning(false);
    }
  };

  const buildProcessItems = (targetItems, action) => {
    const labels = categoryLabelsFromIds(taxonomyTree, batchDefaultCategoryId, batchDefaultSub1Id);
    return targetItems
      // Archive accepts unmatched codes too — they land in the archive as
      // placeholders and get their data allocated once the code is fixed.
      .filter((i) => i.code && (i.group === 'ready' || i.group === 'needs_review'
        || (action === 'archive' && i.group === 'not_found')))
      .map((item) => ({
        path: item.path,
        filename: item.filename,
        code: item.code,
        imageSlot: item.imageSlot || 1,
        displayCode: item.displayCode,
        title: catalogueDisplayTitle(item),
        price: item.price ?? item.sqlRow?.price ?? 0,
        unitsOfIssue: item.unitsOfIssue || 'EACH',
        packDescription: item.packDescription || '',
        description: catalogueDescription(item),
        category: item.websiteRow?.category || (action === 'publish' ? labels.category : labels.category || ''),
        subcategoryOne: item.websiteRow?.subcategory_one || (action === 'publish' ? labels.subcategoryOne : labels.subcategoryOne || ''),
        subcategoryTwo: item.websiteRow?.subcategory_two || null,
        sqlRow: item.sqlRow,
        websiteRow: item.websiteRow,
        warnings: item.warnings,
        overwriteImage: batchOverwrite,
      }));
  };

  const runProcess = async (action, targetItems) => {
    const payload = buildProcessItems(targetItems, action);
    if (!payload.length) {
      setError('No matched products to process.');
      return;
    }
    if (action === 'publish') {
      const needsCategory = payload.some((i) => !i.category);
      if (needsCategory) {
        setError('Pick a default category for products not already on the website.');
        return;
      }
    }

    setProcessing(true);
    setProcessAction(action);
    setError('');
    setProgress({ done: 0, total: payload.length });

    const BATCH = 5;
    let succeeded = 0;
    let failed = 0;
    const failedSkus = [];

    for (let i = 0; i < payload.length; i += BATCH) {
      const chunk = payload.slice(i, i + BATCH);
      setProgress({ done: i, total: payload.length });
      try {
        const res = await fetch('/api/nutstore-process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, items: chunk, overwriteImage: batchOverwrite }),
        });
        const json = await readApiJson(res, { fallback: `${action} failed` });
        succeeded += json.succeeded || 0;
        failed += json.failed || 0;
        if (json.results) {
          for (const hit of json.results) {
            if (!hit.ok) failedSkus.push(`${hit.sku}: ${hit.error || 'failed'}`);
          }
          setItems((prev) => prev.map((row) => {
            const hit = json.results.find((r) => r.sku === row.code);
            if (!hit) return row;
            return { ...row, processStatus: hit.ok ? action : 'error', processError: hit.error || '' };
          }));
        }
      } catch (err) {
        failed += chunk.length;
        setError(err.message || `${action} batch failed`);
      }
    }

    setProgress({ done: payload.length, total: payload.length });
    setProcessing(false);
    setProcessAction('');
    if (action === 'publish') {
      onShowToastRef.current?.(
        `Published ${succeeded}${failed ? `, ${failed} failed` : ''}`,
        failed ? 'warning' : 'success',
      );
      if (succeeded === 1 && payload[0]) {
        onPublished?.({ sku: payload[0].code, action: 'create' });
      }
    } else {
      const detail = failedSkus.length ? ` — ${failedSkus.slice(0, 3).join('; ')}` : '';
      onShowToastRef.current?.(
        `Archived ${succeeded} to Product Manager → Archive (Nutstore tag)${failed ? `, ${failed} failed${detail}` : ''}`,
        failed ? 'warning' : 'success',
      );
    }
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
              <col style={{ width: '28%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 48 }} />
              <col style={{ width: 72 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Preview</th>
                <th>File</th>
                <th>Code</th>
                <th>Description</th>
                <th>Incl. VAT</th>
                <th>SOH</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.path}>
                  <td>
                    <FolderNutstoreThumb path={row.path} folderScope={row.path} />
                  </td>
                  <td className="adm-muted pl-table-clip">
                    <LoaderCodeEllipsis value={row.filename} strong={false} fill />
                  </td>
                  <td className="pl-table-clip">
                    <LoaderCodeEllipsis value={loaderCodeLabel(row)} fill />
                  </td>
                  <td className="pl-table-clip">
                    <LoaderCodeEllipsis value={catalogueDisplayTitle(row)} strong={false} fill />
                  </td>
                  <td>
                    {row.price != null ? `R ${Number(row.price).toFixed(2)}` : '—'}
                    <br /><span className="adm-muted">{row.priceSourceLabel || loaderPriceSourceLabel(row.priceSource)}</span>
                  </td>
                  <td>{row.stockOnHand ?? row.sqlRow?.available ?? '—'}</td>
                  <td className={row.processStatus === 'error' ? 'pl-error' : ''}>
                    {row.websiteStatus || row.group}
                    {loaderPriceUsesCachedData(row.priceSource) ? ' — cached price; review' : ''}
                    {row.processError ? ` — ${row.processError}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  if (status.loading) {
    return (
      <div className="pl-section pl-nutstore">
        <p className="adm-muted"><Loader2 size={14} className="spin" /> Connecting to PTR Photos on Nutstore…</p>
      </div>
    );
  }

  if (!status.ok) {
    return (
      <div className="pl-section pl-nutstore">
        <div className="pl-nutstore-guide pl-nutstore-guide--error">
          <h3>Could not open PTR Photos</h3>
          <p className="pl-error">{status.error || 'Nutstore is not configured or unreachable.'}</p>
          <p className="adm-muted">Expected folder: <strong>/PTR-photos</strong> on your Nutstore account.</p>
        </div>
        <button type="button" className="adm-btn-ghost" onClick={() => void boot()}>
          <RefreshCw size={14} /> Retry connection
        </button>
      </div>
    );
  }

  const processable = [...grouped.ready, ...grouped.needs_review];
  const archivable = [...processable, ...grouped.not_found.filter((i) => i.code)];
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="pl-section pl-nutstore">
      <div className="pl-nutstore-guide">
        <h3 className="pl-nutstore-guide-title">PTR Photos → Website</h3>
        <ol className="pl-nutstore-steps">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      <div className="pl-nutstore-nav">
        <div className="pl-nutstore-nav-buttons">
          <button type="button" className="adm-btn-ghost" disabled={!canGoUp || browseLoading} onClick={goUp}>
            <ArrowLeft size={15} /> Up
          </button>
          <button type="button" className="adm-btn-ghost" disabled={browseLoading} onClick={goHome}>
            <Home size={15} /> PTR Photos home
          </button>
          <button type="button" className="adm-btn-ghost" disabled={browseLoading} onClick={() => void loadDirectory(currentPath, search)}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>

        <nav className="pl-nutstore-crumbs" aria-label="Folder path">
          {breadcrumbs.map((crumb, idx) => (
            <span key={crumb.path} className="pl-nutstore-crumb">
              {idx > 0 && <ChevronRight size={14} className="pl-nutstore-crumb-sep" />}
              <button
                type="button"
                className={idx === breadcrumbs.length - 1 ? 'pl-nutstore-crumb--current' : ''}
                onClick={() => goTo(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="pl-nutstore-toolbar">
        <div className="pl-nutstore-search">
          <Search size={15} />
          <input
            type="search"
            placeholder="Filter folders and images in this location…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void loadDirectory(currentPath, search); }}
          />
          <button type="button" className="adm-btn-ghost" onClick={() => void loadDirectory(currentPath, search)}>
            Filter
          </button>
        </div>
      </div>

      <div className="pl-nutstore-select-bar">
        <button type="button" className="adm-btn-ghost" disabled={browseLoading || !images.length} onClick={selectAllImagesInView}>
          Select all images here ({images.length})
        </button>
        <button type="button" className="adm-btn-ghost" disabled={browseLoading} onClick={() => void selectEntireFolder()}>
          <FolderOpen size={14} /> Select all images in subfolders
        </button>
        {selected.size > 0 && (
          <button type="button" className="adm-btn-ghost" onClick={clearSelection}>
            Clear selection ({selected.size})
          </button>
        )}
      </div>

      <div className="pl-nutstore-panels">
        <section className="pl-nutstore-panel">
          <header className="pl-nutstore-panel-head">
            <Folder size={16} />
            <span>Subfolders</span>
            <span className="adm-muted">{folders.length}</span>
          </header>
          <div className="pl-nutstore-panel-body">
            {browseLoading ? (
              <p className="adm-muted pl-nutstore-loading"><Loader2 size={14} className="spin" /> Loading…</p>
            ) : folders.length ? (
              <ul className="pl-nutstore-folder-grid">
                {folders.map((entry) => (
                  <li key={entry.path}>
                    <button type="button" className="pl-nutstore-folder-card" onClick={() => goTo(entry.path, entry.href || entry.requestHref)}>
                      <Folder size={20} />
                      <span>{entry.name}</span>
                      <ChevronRight size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="adm-muted pl-nutstore-empty">No subfolders — product images are listed on the right.</p>
            )}
          </div>
        </section>

        <section className="pl-nutstore-panel pl-nutstore-panel--images">
          <header className="pl-nutstore-panel-head">
            <span>Product images</span>
            <span className="adm-muted">{images.length}</span>
          </header>
          <div className="pl-nutstore-panel-body">
            {browseLoading ? (
              <p className="adm-muted pl-nutstore-loading"><Loader2 size={14} className="spin" /> Loading…</p>
            ) : images.length ? (
              <ul className="pl-nutstore-image-list">
                {images.map((entry) => (
                  <li key={entry.path}>
                    <label className={`pl-nutstore-image-row${selected.has(entry.path) ? ' pl-nutstore-image-row--on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(entry.path)}
                        onChange={() => toggleSelect(entry.path)}
                      />
                      <FolderNutstoreThumb path={entry.path} folderScope={currentPath} />
                      <span className="pl-nutstore-image-card-name" title={entry.name}>{entry.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="adm-muted pl-nutstore-empty">No images in this folder. Open a subfolder on the left.</p>
            )}
          </div>
        </section>
      </div>

      {error && <p className="pl-error pl-nutstore-error">{error}</p>}

      <div className="pl-nutstore-lookup-bar">
        <button type="button" className="adm-btn-red" disabled={scanning || !selected.size} onClick={() => void lookupSelected()}>
          {scanning ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          Step 3 — Look up {selected.size} selected in Positill
        </button>
        {onProcessSelected && (
          <button
            type="button"
            className="adm-btn-ghost"
            disabled={scanning || !selected.size}
            onClick={() => onProcessSelected(selectedPaths.map((path) => ({
              path,
              filename: images.find((entry) => entry.path === path)?.name || path.split('/').pop(),
            })))}
          >
            <Sparkles size={14} /> Improve selected ({selected.size})
          </button>
        )}
        {lookupStale && hasResults && !scanning && (
          <span className="adm-muted" style={{ fontSize: 12 }}>Selection changed — run lookup again to refresh results.</span>
        )}
      </div>

      {scanning && (
        <p className="adm-muted pl-nutstore-loading" style={{ marginTop: 12 }}>
          <Loader2 size={14} className="spin" /> Looking up {selected.size} product(s) in Positill…
        </p>
      )}

      {hasResults && (
        <div className="pl-nutstore-results" ref={resultsRef}>
          {!scanning && items.length > 0 && (
            <div className="pl-summary-dashboard">
              <div><strong>{items.length}</strong><span>Looked up</span></div>
              <div><strong>{grouped.ready.length}</strong><span>Ready</span></div>
              <div><strong>{grouped.needs_review.length}</strong><span>Needs review</span></div>
              <div><strong>{grouped.not_found.length}</strong><span>Not found</span></div>
            </div>
          )}

          {processing && (
            <div className="pl-progress">
              <div className="pl-progress-bar" style={{ width: `${pct}%` }} />
              <span>{processAction}… {progress.done}/{progress.total}</span>
            </div>
          )}

          {!scanning && renderGroup('ready')}
          {!scanning && renderGroup('needs_review')}
          {!scanning && renderGroup('not_found')}

          {!scanning && items.length > 0 && (
            <>
              <div className="pl-action-row" style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  className="adm-btn-ghost"
                  disabled={processing || !archivable.length}
                  onClick={() => void runProcess('archive', archivable)}
                >
                  {processing && processAction === 'archive' ? <Loader2 size={14} className="spin" /> : <Archive size={14} />}
                  Archive ({archivable.length}) — includes not-found, no category needed
                </button>
              </div>

              <p className="adm-section-note" style={{ margin: '0 0 10px', fontSize: 12 }}>
                Publish only: pick a default category for new products. Archive uses Positill data and tags items as Nutstore in Product Manager → Archive.
              </p>
              <div className="pl-inline-fields">
                <label>
                  Default category (new products)
                  <select className="adm-select adm-select--enhanced" value={batchDefaultCategoryId} onChange={(e) => { setBatchDefaultCategoryId(e.target.value); setBatchDefaultSub1Id(''); }}>
                    <option value="">— Select if needed —</option>
                    {taxonomyTree.map((cat) => <option key={cat.id} value={cat.id}>{cat.label}</option>)}
                  </select>
                </label>
                {batchSub1Options.length > 0 && (
                  <label>
                    Default subcategory
                    <select className="adm-select adm-select--enhanced" value={batchDefaultSub1Id} onChange={(e) => setBatchDefaultSub1Id(e.target.value)}>
                      <option value="">— Optional —</option>
                      {batchSub1Options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
                    </select>
                  </label>
                )}
                <label className="pl-check">
                  <input type="checkbox" checked={batchOverwrite} onChange={(e) => setBatchOverwrite(e.target.checked)} />
                  Replace image if slot already filled
                </label>
              </div>

              <div className="pl-action-row">
                <button
                  type="button"
                  className="adm-btn-red"
                  disabled={processing || !processable.length}
                  onClick={() => void runProcess('publish', processable)}
                >
                  {processing && processAction === 'publish' ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                  Publish to website ({processable.length})
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
