import { useCallback, useEffect, useRef, useState } from 'react';
import { loadInstoreCopy, updateInstoreCopy } from '../../lib/instoreCopyApi.js';
import { instoreCopyError } from '../../../lib/instore-copy.mjs';
import InstoreCopyFields from './InstoreCopyFields.jsx';

export default function InstoreCopyEditor({ openRequest, onPendingChange, disabled = false }) {
  const [sku, setSku] = useState('');
  const [record, setRecord] = useState(null);
  const [copy, setCopy] = useState({ title: '', description: '' });
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const panelRef = useRef(null);
  const sequence = useRef(0);
  const savingRef = useRef(false);
  const dirty = Boolean(record && (copy.title !== record.title || copy.description !== record.original_description));
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => { onPendingChange?.(dirty || busy); }, [dirty, busy, onPendingChange]);
  useEffect(() => () => { sequence.current += 1; onPendingChange?.(false); }, [onPendingChange]);

  const load = useCallback(async (code) => {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm('Discard your unsaved website wording and reload a product?')) return;
    const exact = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(exact)) { setError('Enter the exact Instore product code.'); return; }
    const request = ++sequence.current;
    setBusy(true); setError(''); setMessage(''); setReviewing(false); setSku(exact); setRecord(null);
    try {
      const result = await loadInstoreCopy(exact);
      if (request !== sequence.current) return;
      setRecord(result.item); setCanEdit(result.canEdit === true); setNeedsReload(false);
      setCopy({ title: result.item.title || '', description: result.item.original_description || '' });
    } catch (err) { if (request === sequence.current) setError(err.message || 'Could not load the item.'); }
    finally { if (request === sequence.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!openRequest?.sku) return;
    panelRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    void load(openRequest.sku);
  }, [openRequest, load]);

  const save = async () => {
    if (!record || busy || disabled || !canEdit || needsReload || instoreCopyError(copy)) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await updateInstoreCopy(record, copy);
      setRecord(result.item); setCopy({ title: result.item.title, description: result.item.original_description });
      setReviewing(false);
      setMessage(`Saved website wording for ${record.sku}. ${result.warning || 'Refresh the website to check it; cached listings may take a few minutes to update.'}`);
    } catch (err) { setError(err.message || 'Save could not be confirmed.'); setNeedsReload(true); }
    finally { savingRef.current = false; setBusy(false); }
  };

  return <section ref={panelRef} className="ic-editor" aria-label="Edit listed Instore wording">
    <h3>Edit a listed Instore product</h3><p>Enter its exact code to rename it or change its website description. Main catalogue products use Product Manager.</p>
    <form className="ic-lookup" onSubmit={(event) => { event.preventDefault(); void load(sku); }}>
      <label>Exact product code<input aria-label="Exact Instore product code" value={sku} disabled={busy || disabled} onChange={(event) => setSku(event.target.value.toUpperCase())} placeholder="e.g. 78446" /></label>
      <button type="submit" className="adm-btn-ghost" disabled={busy || disabled}>{busy ? 'Working…' : 'Find Instore product'}</button>
    </form>
    {error && <p className="ic-error" role="alert">{error}</p>}
    {message && <p className="ic-success" role="status">{message}</p>}
    {record && <>
      <p className="ic-record"><strong>{record.sku}</strong> · R {Number(record.price).toFixed(2)} · {record.available_stock} available <span>Code, price, stock and image are read-only here.</span></p>
      {!canEdit && <p role="status">Test preview — saving website wording is disabled.</p>}
      <InstoreCopyFields sku={record.sku} copy={copy} disabled={busy || disabled || !canEdit} onChange={(value) => { setCopy(value); setReviewing(false); setMessage(''); }} />
      {!reviewing && <div className="ic-actions">
        <button type="button" className="adm-btn-red" disabled={busy || disabled || !canEdit || !dirty || needsReload || Boolean(instoreCopyError(copy))} onClick={() => setReviewing(true)}>Review website changes</button>
        <button type="button" className="adm-btn-ghost" disabled={busy || disabled || !dirty} onClick={() => { setCopy({ title: record.title || '', description: record.original_description || '' }); setReviewing(false); setError(''); }}>Cancel changes</button>
      </div>}
      {needsReload && <button type="button" className="adm-btn-ghost" disabled={busy || disabled} onClick={() => void load(record.sku)}>Reload saved wording</button>}
      {reviewing && <div className="ic-confirmation" aria-label="Review website wording changes">
        <h4>Confirm website changes · {record.sku}</h4>
        <dl><dt>Current name</dt><dd>{record.title}</dd><dt>New name</dt><dd>{copy.title.trim()}</dd><dt>Current description</dt><dd>{record.original_description}</dd><dt>New description</dt><dd>{copy.description.trim()}</dd></dl>
        <p>This changes the website wording of this listed Instore product only.</p>
        <div className="ic-actions"><button type="button" className="adm-btn-red" disabled={busy || disabled || !canEdit || needsReload} onClick={() => void save()}>{busy ? 'Saving…' : 'Confirm save website wording'}</button>
          <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => setReviewing(false)}>Back to editing</button></div>
      </div>}
    </>}
  </section>;
}
