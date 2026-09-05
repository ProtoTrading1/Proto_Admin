import { useEffect, useMemo, useState } from 'react';
import { Loader2, Layers, X } from 'lucide-react';

/**
 * Merge the selected products into one storefront variant group (migration 052).
 * The admin picks a primary member (the card the group shows as), an optional
 * group title, and a short variant label per member. POSTs to
 * /api/product-groups; the caller clears selection + refetches the catalogue.
 */
export default function MergeIntoGroupModal({ open, onClose, rows = [], onCreated, onShowToast }) {
  const members = useMemo(
    () => rows.map((r) => ({ sku: String(r.sku || r.id || '').trim().toUpperCase(), title: r.title || r.name || r.sku, image: r.image || '' })).filter((m) => m.sku),
    [rows],
  );

  const [title, setTitle] = useState('');
  const [primarySku, setPrimarySku] = useState('');
  const [labels, setLabels] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setPrimarySku(members[0]?.sku || '');
    setLabels({});
    setError('');
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const create = async () => {
    if (members.length < 2) { setError('Select at least two products to merge.'); return; }
    if (!primarySku) { setError('Choose which product the group card shows as.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/product-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim() || null,
          primaryWebsiteSku: primarySku,
          members: members.map((m, i) => ({ sku: m.sku, variantLabel: (labels[m.sku] || '').trim() || null, sortOrder: i })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Merge failed');
      onShowToast?.(`Merged ${members.length} products into one group`, 'success');
      onCreated?.(json);
      onClose?.();
    } catch (err) {
      setError(err.message || 'Merge failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="adm-modal-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '85vh', overflow: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid #e2e8f0' }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers size={18} /> Merge into one product card
          </h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={18} /></button>
        </div>

        <div style={{ padding: '18px 22px' }}>
          <p className="adm-section-note" style={{ marginTop: 0 }}>
            These {members.length} products will show on the site as <strong>one card with a variant selector</strong>. Customers
            pick a variant to add; each order line still uses that variant’s own code. The card shows the primary you choose.
          </p>

          <label className="adm-field" style={{ marginBottom: 16 }}>
            <span className="adm-field-label">Group title (optional — defaults to the primary’s title)</span>
            <input className="adm-field-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ballpoint Pens" />
          </label>

          <div className="adm-field-label" style={{ marginBottom: 8 }}>Members ({members.length}) — pick the primary and label each variant</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {members.map((m) => (
              <div key={m.sku} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: `1px solid ${primarySku === m.sku ? '#8B1A1A' : '#e2e8f0'}`, borderRadius: 10, background: primarySku === m.sku ? 'rgba(139,26,26,0.04)' : '#fff' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }} title="Show the group as this product">
                  <input type="radio" name="primary" checked={primarySku === m.sku} onChange={() => setPrimarySku(m.sku)} style={{ accentColor: '#8B1A1A' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: primarySku === m.sku ? '#8B1A1A' : '#94a3b8' }}>Primary</span>
                </label>
                {m.image ? <img src={m.image} alt="" style={{ width: 34, height: 34, objectFit: 'contain', borderRadius: 6, border: '1px solid #e2e8f0', flexShrink: 0 }} /> : <div style={{ width: 34, height: 34, borderRadius: 6, background: '#f1f5f9', flexShrink: 0 }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</div>
                  <div className="adm-muted" style={{ fontSize: 11 }}>{m.sku}</div>
                </div>
                <input
                  className="adm-field-input"
                  style={{ width: 130, flexShrink: 0 }}
                  value={labels[m.sku] || ''}
                  onChange={(e) => setLabels((prev) => ({ ...prev, [m.sku]: e.target.value }))}
                  placeholder="Variant label"
                  aria-label={`Variant label for ${m.sku}`}
                />
              </div>
            ))}
          </div>

          {error && <div style={{ marginTop: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{error}</div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', borderTop: '1px solid #e2e8f0' }}>
          <button type="button" className="adm-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="adm-btn-red" onClick={() => void create()} disabled={saving || members.length < 2}>
            {saving ? <><Loader2 size={14} className="spin" style={{ marginRight: 6, verticalAlign: -2 }} /> Merging…</> : `Merge ${members.length} into a group`}
          </button>
        </div>
      </div>
    </div>
  );
}
