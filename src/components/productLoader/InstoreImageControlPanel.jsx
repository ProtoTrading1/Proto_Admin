import { useState } from 'react';
import { Archive, EyeOff, ImageOff, Loader2, RefreshCw, Search, Undo2 } from 'lucide-react';
import { readApiJson } from '../../lib/apiError.js';

function normaliseSku(value) {
  return String(value || '').trim().toUpperCase();
}

async function readControl(sku) {
  const response = await fetch(`/api/instore-image-controls?sku=${encodeURIComponent(sku)}`, { cache: 'no-store' });
  return readApiJson(response);
}

export default function InstoreImageControlPanel({ onShowToast }) {
  const [sku, setSku] = useState('');
  const [record, setRecord] = useState(null);
  const [reason, setReason] = useState('Incorrect or misleading product image');
  const [listingReason, setListingReason] = useState('Remove from Instore Products');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const code = normaliseSku(sku);
    if (!code) {
      setError('Enter the exact Instore SKU first.');
      return;
    }
    setLoading(true); setError(''); setRecord(null);
    try {
      setRecord(await readControl(code));
    } catch (err) {
      setError(err?.message || 'Could not load this Instore image record.');
    } finally { setLoading(false); }
  };

  const change = async (action) => {
    if (!record?.item?.sku) return;
    const activeReason = action === 'hide-listing' ? listingReason : reason;
    if ((action === 'hide' || action === 'hide-listing') && !String(activeReason || '').trim()) {
      setError('Give a brief reason so the change is auditable.');
      return;
    }
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/instore-image-controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: record.item.sku, action, reason: activeReason }),
      });
      const result = await readApiJson(response);
      setRecord(await readControl(record.item.sku));
      onShowToast?.(action === 'hide'
        ? `${result.item.sku}: image hidden. Product, price and stock are unchanged.`
        : action === 'hide-listing'
          ? `${result.item.sku}: removed from Instore Products. The main catalogue, price and stock are unchanged.`
          : action === 'restore-listing'
            ? `${result.item.sku}: restored to Instore Products.`
        : `${result.item.sku}: original image restored.`);
    } catch (err) {
      setError(err?.message || 'Could not update this image control.');
    } finally { setSaving(false); }
  };

  const hidden = record?.control?.status === 'hidden';
  const listingHidden = record?.listingControl?.status === 'hidden';
  return (
    <section className="ipc-instore-image-control" aria-labelledby="instore-image-control-title">
      <div>
        <span className="ipc-eyebrow"><Archive size={14} /> Instore photo safety</span>
        <h4 id="instore-image-control-title">Hide a wrong photo without archiving the product</h4>
        <p>The SKU remains searchable and sellable. Customers see “Image being updated” until you restore or replace the verified photo.</p>
      </div>
      <div className="ipc-instore-image-control-search">
        <label htmlFor="instore-image-control-sku">Exact Instore SKU</label>
        <div>
          <input id="instore-image-control-sku" value={sku} onChange={(event) => setSku(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(); }} placeholder="e.g. 8602016003" />
          <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading || saving}><Search size={14} /> Find</button>
        </div>
      </div>
      {loading && <p className="adm-muted"><Loader2 size={14} className="spin" /> Loading exact image record…</p>}
      {error && <p className="ipc-config-warning" role="alert">{error}</p>}
      {record?.item && <div className="ipc-instore-image-control-record">
        <div className="ipc-instore-image-control-preview">
          {hidden || !record.item.image_url ? <div className="ipc-instore-image-placeholder"><ImageOff size={28} /><span>Image being updated</span></div> : <img src={record.item.image_url} alt={record.item.title || record.item.sku} />}
        </div>
        <div>
          <strong>{record.item.title || record.item.sku}</strong>
          <span>SKU: {record.item.sku} · R{Number(record.item.price || 0).toFixed(2)} · {Number(record.item.available_stock || 0)} available</span>
          <span>{hidden ? 'Photo hidden from customers' : 'Current photo visible to customers'}</span>
          <span>{listingHidden ? 'Removed from Instore Products' : 'Available in Instore Products'}</span>
          {!hidden && <label>Reason for hiding<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label>}
          <div className="ipc-instore-image-control-actions">
            {hidden
              ? <button type="button" className="adm-btn-ghost" onClick={() => void change('restore')} disabled={saving}><Undo2 size={14} /> Restore original image</button>
              : <button type="button" className="adm-btn-red" onClick={() => void change('hide')} disabled={saving}><ImageOff size={14} /> Hide incorrect image</button>}
            <button type="button" className="adm-btn-ghost" onClick={() => void load()} disabled={loading || saving}><RefreshCw size={14} /> Refresh</button>
          </div>
          {!listingHidden && <label>Reason for removing from Instore Products<textarea value={listingReason} onChange={(event) => setListingReason(event.target.value)} maxLength={500} /></label>}
          <div className="ipc-instore-image-control-actions">
            {listingHidden
              ? <button type="button" className="adm-btn-ghost" onClick={() => void change('restore-listing')} disabled={saving}><Undo2 size={14} /> Restore to Instore Products</button>
              : <button type="button" className="adm-btn-red" onClick={() => void change('hide-listing')} disabled={saving}><EyeOff size={14} /> Hide from Instore Products</button>}
          </div>
          <small>This does not archive the product or alter price, stock, images, or the main website catalogue.</small>
          {record.events?.length > 0 && <small>Latest change: {record.events[0].previous_status} → {record.events[0].next_status} · {new Date(record.events[0].created_at).toLocaleString()}</small>}
        </div>
      </div>}
    </section>
  );
}
