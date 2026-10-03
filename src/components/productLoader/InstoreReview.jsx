import { useEffect, useMemo, useRef, useState } from 'react';
import { catalogueDisplayTitle, catalogueDescription } from '../../lib/productLoaderDisplay.js';
import InstoreCopyFields from './InstoreCopyFields.jsx';
import { filterInstoreReview, groupInstoreDestinations, INSTORE_REVIEW_LABELS, summarizeInstoreReview } from '../../lib/instoreReview.js';
import './InstoreReview.css';

export default function InstoreReview({ entries, selected, busy, importEnabled, importBlockReason,
  categoryPicker, onAssignCategory, canAssignCategory, onSelect, onClearSelection, onImport, onRefresh,
  stockInfo, receipt = [], onRetryFailed, stockMode, statusState = importEnabled ? 'enabled' : 'disabled', onRetryStatus, onCopyChange, onEditListed }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('working');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [destination, setDestination] = useState('');
  const [productGroup, setProductGroup] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const reviewRef = useRef(null);
  const confirmationRef = useRef(null);
  // The admin header wraps at mobile widths. Measure the actual shell instead
  // of guessing a fixed desktop/mobile offset that can obscure the selection.
  useEffect(() => {
    const header = document.querySelector('.adm-header');
    const review = reviewRef.current;
    if (!header || !review) return undefined;
    const update = () => review.style.setProperty('--ir-header-offset', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(header);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { if (reviewing) { confirmationRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); confirmationRef.current?.focus?.({ preventScroll: true }); } }, [reviewing]);
  const counts = summarizeInstoreReview(entries);
  const filtered = useMemo(() => filterInstoreReview(entries, { query, status, selectedOnly, selected, destination, productGroup }),
    [entries, query, status, selectedOnly, selected, destination, productGroup]);
  const selectedEntries = entries.filter((entry) => selected.has(entry.key));
  const blocked = selectedEntries.filter((entry) => entry.state !== 'ready');
  const destinations = [...new Set(entries.map(({ row }) => row.instoreCategoryPath?.join(' › ')).filter(Boolean))];
  const groups = [...new Set(entries.map(({ row }) => String(row.productGroup || row.sqlRow?.GROUP || row.sqlRow?.group || '')).filter(Boolean))];
  const selectable = filtered.filter((entry) => entry.canReview);
  const allSelected = selectable.length > 0 && selectable.every((entry) => selected.has(entry.key));
  const disabledReason = importBlockReason || (blocked.length ? `${blocked.length} selected product${blocked.length === 1 ? '' : 's'} need attention before adding.` : '');
  const added = receipt.filter((item) => item.outcome === 'added');
  const skipped = receipt.filter((item) => item.outcome === 'skipped');
  const failed = receipt.filter((item) => item.outcome === 'failed');

  return <section ref={reviewRef} className="instore-review" aria-label="Review products for Instore">
    <header className="ir-heading"><div><span className="ir-step">STEP 2</span><h3>Review products</h3></div><p>{counts.total} unique products · {stockMode === 'positill_live' ? 'Live Positill stock' : 'New receipt'}</p></header>
    <div className="ir-actionbar" aria-label="Instore selection actions">
      {statusState === 'disabled' && <strong className="ir-preview" role="status">Test preview — adding products is disabled</strong>}
      {(statusState === 'error' || statusState === 'loading') && <div role={statusState === 'error' ? 'alert' : 'status'}>
        <strong>{statusState === 'loading' ? 'Checking Instore import status…' : 'The Instore import status could not be confirmed.'}</strong>
        {statusState === 'error' && <button type="button" className="adm-btn-ghost" disabled={busy} onClick={onRetryStatus}>Retry status check</button>}
      </div>}
      <div className="ir-actionbar-controls"><strong>{selectedEntries.length} product{selectedEntries.length === 1 ? '' : 's'} selected{blocked.length ? ` · ${blocked.length} need attention` : ''}</strong>
        <button type="button" className="adm-btn-ghost" disabled={busy || !selectedEntries.length} onClick={() => { onClearSelection(); setReviewing(false); }}>Clear selection</button>
        <button type="button" className="adm-btn-ghost" onClick={() => setSelectedOnly((value) => !value)} aria-pressed={selectedOnly}>Selected only</button>
        <button type="button" className="adm-btn-red" disabled={busy || Boolean(disabledReason)} onClick={() => setReviewing(true)}>{busy ? 'Working…' : 'Review and add to Instore'}</button></div>
      {disabledReason && <p role="status">{disabledReason}</p>}
    </div>
    <div className="ir-counts" aria-label="Product status totals">
      {Object.entries(INSTORE_REVIEW_LABELS).map(([value, label]) => <button type="button" key={value} aria-pressed={status === value && !selectedOnly}
        onClick={() => { setStatus(value); setSelectedOnly(false); }}><strong>{counts[value]}</strong><span>{label}</span></button>)}
    </div>
    <div className="ir-filters">
      <label>Search products<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SKU or description" /></label>
      <label>Show<select value={status} onChange={(event) => { setStatus(event.target.value); setSelectedOnly(false); }}>
        <option value="working">Working list (hide already listed)</option><option value="all">All products</option>
        {Object.entries(INSTORE_REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        <option value="instore">Already in Instore</option><option value="main">On main site</option>
      </select></label>
      <label>Destination<select value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">All destinations</option>{destinations.map((value) => <option key={value}>{value}</option>)}</select></label>
      {groups.length > 0 && <label>Product group<select value={productGroup} onChange={(event) => setProductGroup(event.target.value)}><option value="">All groups</option>{groups.map((value) => <option key={value}>{value}</option>)}</select></label>}
      <label className="ir-check"><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />Selected only</label>
    </div>
    <div className="ir-batch">
      <div className="ir-batch-top"><button type="button" className="adm-btn-ghost" disabled={busy || !selectable.length} onClick={() => onSelect(selectable.map((entry) => entry.key), !allSelected)}>{allSelected ? 'Clear selection in these results' : `Select reviewable products in these results (${selectable.length})`}</button>
        <button type="button" className="adm-btn-ghost" disabled={busy} onClick={onRefresh}>Retry live lookup</button><span>{filtered.length} of {counts.total} products shown</span></div>
      <p>Select products, choose their destination, then assign it. Selection alone never makes a blocked product eligible to add.</p>
      <div className="ir-assignment">{categoryPicker}<button type="button" className="adm-btn-ghost" disabled={busy || !selectedEntries.length || !canAssignCategory} onClick={() => { onAssignCategory(); setReviewing(false); }}>Assign category to selected ({selectedEntries.length})</button></div>
    </div>
    <div className="ir-products" role="list" aria-label="Products">
      <div className="ir-table-head" aria-hidden="true"><span>Select</span><span>Product</span><span>Price / stock</span><span>Destination / status</span></div>
      {filtered.map((entry) => {
        const { row, key, sku, state, reason } = entry;
        const stock = stockInfo(row);
        const price = Number(row.price);
        return <article className={`ir-product ir-product--${state}`} role="listitem" key={key}>
          <label className="ir-select"><input type="checkbox" aria-label={`Select ${sku || row.filename} for review`} checked={selected.has(key)} disabled={busy || (!entry.canReview && !selected.has(key))}
            onChange={(event) => { onSelect([key], event.target.checked); setReviewing(false); }} /><span className="ir-mobile-label">Select for review</span></label>
          <div className="ir-identity">{row.previewUrl && <img src={row.previewUrl} alt={`Product ${sku}`} loading="lazy" />}<div><strong className="ir-sku">{sku || 'Unresolved SKU'}</strong><p>{catalogueDisplayTitle(row) || row.description || row.sqlRow?.description || row.sqlRow?.DESCRIPTION || row.filename}</p><small>{row.sharedFamilySource ? `Shared main photo: ${row.sharedFamilySource}` : row.filename}</small></div></div>
          <div className="ir-stock"><strong>{Number.isFinite(price) && price > 0 ? `R ${price.toFixed(2)}` : 'Price unavailable'}</strong><span>{price > 0 ? 'incl. VAT' : 'Check live Positill pricing'}</span><strong>{stock.label}</strong><details><summary>Stock details</summary><p>{stock.details}</p></details></div>
          <div className="ir-status"><span className={`ir-badge ir-badge--${state}`}>{INSTORE_REVIEW_LABELS[state]}</span><p>{reason}</p><span className="ir-destination">Destination: {row.instoreCategoryPath?.join(' › ') || 'Unassigned'}</span>
            {row.processError && <p className="ir-error">Last attempt: {row.processError}</p>}
            {state === 'attention' && <small>{/category|destination/i.test(reason) ? 'Select this product, then assign its destination above.'
              : /filename|exact SKU/i.test(reason) ? 'Check the image filename against the exact Positill SKU, then choose the corrected image.'
                : 'Check its source details or retry live lookup.'}</small>}
            {state === 'listed' && <small>Edit the existing catalogue item to make changes.</small>}
            {entry.listedInstore && onEditListed && <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => onEditListed(sku)}>Edit website wording</button>}
          </div>
          {entry.canReview && onCopyChange && <details className="ir-copy-draft" onToggle={() => setReviewing(false)}>
            <summary>{row.instoreCopy ? 'Website wording edited — review or reset' : 'Edit website name and description before adding'}</summary>
            <p className="ir-copy-source">Positill wording (unchanged): {catalogueDescription(row) || catalogueDisplayTitle(row)}</p>
            <InstoreCopyFields sku={sku} disabled={busy} copy={row.instoreCopy || { title: catalogueDisplayTitle(row).toUpperCase(), description: catalogueDescription(row).toUpperCase() }}
              onChange={(copy) => { onCopyChange(key, copy); setReviewing(false); }} />
            <button type="button" className="adm-btn-ghost" disabled={busy || !row.instoreCopy} onClick={() => { onCopyChange(key, null); setReviewing(false); }}>Reset to Positill wording</button>
            <small>Draft only. Nothing is saved until you confirm adding this product.</small>
          </details>}
        </article>;
      })}
      {!filtered.length && <p className="ir-empty">No products match these filters. Change the filters to see the rest of this batch.</p>}
    </div>
    {reviewing && <section ref={confirmationRef} tabIndex={-1} className="ir-confirmation" aria-label="Final Instore review">
      <span className="ir-step">STEP 3</span><h3>Review and add to Instore</h3><p>{selectedEntries.length} selected {selectedEntries.length === 1 ? 'product' : 'products'}. The server checks current stock and duplicates again before adding.</p>
      <ul>{groupInstoreDestinations(selectedEntries).map((group) => <li key={group.destination}><strong>{group.destination} · {group.count}</strong><p>{group.skus.join(', ')}</p></li>)}</ul>
      <h4>Website wording to publish (CAPITALS)</h4>
      <ul className="ir-copy-summary">{selectedEntries.map(({ row, sku }) => <li key={sku}><strong>{sku} · {row.instoreCopy?.title || catalogueDisplayTitle(row).toUpperCase()}</strong><br />{row.instoreCopy?.description || catalogueDescription(row).toUpperCase()}</li>)}</ul>
      {blocked.length > 0 && <p role="alert">Resolve every selected product that needs attention, or remove it from the selection.</p>}
      <button type="button" className="adm-btn-red" disabled={busy || Boolean(disabledReason)} onClick={() => { setReviewing(false); void onImport(); }}>Confirm add {selectedEntries.length} {selectedEntries.length === 1 ? 'product' : 'products'} to Instore</button>
      <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => setReviewing(false)}>Back to review</button>
    </section>}
    {receipt.length > 0 && <section className="ir-receipt" aria-label="Import results" aria-live="polite"><h3>Import results</h3><p><strong>Added: {added.length}</strong> · Skipped (already listed): {skipped.length} · Failed: {failed.length}</p>
      <ul>{receipt.map((item) => <li key={item.sku}><strong>{item.sku} — {item.outcome === 'added' ? 'Added' : item.outcome === 'skipped' ? 'Skipped' : 'Failed'}</strong><span>{item.reason}</span>{item.url && <a href={item.url} target="_blank" rel="noreferrer">View product</a>}</li>)}</ul>
      {failed.length > 0 && <button type="button" className="adm-btn-ghost" disabled={busy || !importEnabled} onClick={onRetryFailed}>Review failed products for retry ({failed.length})</button>}
    </section>}

  </section>;
}
