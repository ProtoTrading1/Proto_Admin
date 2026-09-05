import { useEffect, useState } from 'react';
import { Clock, Loader2, Save } from 'lucide-react';
import CategorySidebar from './CategorySidebar';

export default function ComingSoonPanel({ taxonomyTree = [] }) {
  const [categoryIds, setCategoryIds] = useState([]);
  const [skus, setSkus] = useState([]);
  const [skuInput, setSkuInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/coming-soon');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setCategoryIds(json.categoryIds || []);
      setSkus(json.skus || []);
      setUpdatedAt(json.updatedAt || null);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const toggleCategory = (path) => {
    if (!path.length) return;
    const id = path[path.length - 1];
    setCategoryIds((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  };

  const addSku = () => {
    const s = skuInput.trim();
    if (!s) return;
    setSkus((prev) => [...new Set([...prev, s])]);
    setSkuInput('');
  };

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/coming-soon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryIds,
          skus,
          ...(updatedAt ? { baseUpdatedAt: updatedAt } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setUpdatedAt(json.updatedAt || null);
      setMessage('Saved. Storefront can read this config in a follow-up PR.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="adm-panel">
        <div className="adm-loading-inline"><Loader2 size={18} className="spin" /> Loading…</div>
      </div>
    );
  }

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title"><Clock size={18} /> Dormant Products</h2>
          <p className="adm-section-note">Mark categories or SKUs as dormant on the live site. Stored in site config for protoportal-main to consume.</p>
        </div>
        <button type="button" className="adm-btn-red" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Save
        </button>
      </div>
      {message && <p className="adm-section-note">{message}</p>}

      <div className="coming-soon-layout">
        <div>
          <h3 className="adm-subtitle">Categories</h3>
          <p className="adm-muted" style={{ fontSize: 12, marginBottom: 8 }}>Click a category to toggle coming soon. Selected: {categoryIds.length}</p>
          <CategorySidebar
            tree={taxonomyTree}
            selectedPath={[]}
            onSelectPath={toggleCategory}
          />
          {categoryIds.length > 0 && (
            <ul className="coming-soon-tags">
              {categoryIds.map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => setCategoryIds((p) => p.filter((x) => x !== id))}>{id} ×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="adm-subtitle">SKUs</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="adm-field-input" value={skuInput} onChange={(e) => setSkuInput(e.target.value)} placeholder="Barcode / SKU" onKeyDown={(e) => { if (e.key === 'Enter') addSku(); }} />
            <button type="button" className="adm-btn-ghost" onClick={addSku}>Add</button>
          </div>
          <ul className="coming-soon-tags">
            {skus.map((sku) => (
              <li key={sku}>
                <button type="button" onClick={() => setSkus((p) => p.filter((x) => x !== sku))}>{sku} ×</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
