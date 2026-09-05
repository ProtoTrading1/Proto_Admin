import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchReorderProducts, updateProduct } from '../lib/products';
import { subcategoryOptionsFromTree } from '../lib/taxonomyAdmin';
import { saveSpecials } from '../lib/specials';
import { ADMIN_REFRESH_EVENT } from '../lib/adminRefresh';
import { buildPricingPreflight } from '../lib/pricingPreflight';

// Pricing — bulk-adjust selected products by a percentage and stamp them
// onto This Week's Specials. Extracted from AdminPage so state, load and
// apply handlers live with the panel. The Specials list is still owned by
// AdminPage because Product Manager's star toggle mutates the same array.
export default function PricingPanel({
  taxonomyTree = [],
  specials,
  onSpecialsChange,
  onShowToast,
}) {
  const mainCategories = (taxonomyTree || []).map((c) => ({ id: c.id, label: c.label }));
  const [category, setCategory] = useState(mainCategories[0]?.id || '');
  const [subcategory, setSubcategory] = useState('all');
  const [products, setProducts] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [delta, setDelta] = useState('-10');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewedSignature, setReviewedSignature] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const toast = useCallback((message, type = 'success') => {
    onShowToast?.(message, type);
  }, [onShowToast]);

  const load = useCallback(async (categoryId) => {
    if (!categoryId) return;
    setLoading(true);
    try {
      const rows = await fetchReorderProducts({ mainCategory: categoryId });
      setProducts(rows);
    } catch (err) {
      toast(err.message || 'Failed to load products', 'error');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(category); }, [category, load]);

  useEffect(() => {
    const onRefresh = (event) => {
      if (event.detail === 'pricing') void load(category);
    };
    window.addEventListener(ADMIN_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, onRefresh);
  }, [category, load]);

  useEffect(() => {
    if (!mainCategories.some((c) => c.id === category) && mainCategories[0]?.id) {
      setCategory(mainCategories[0].id);
    }
  }, [mainCategories, category]);

  const visible = subcategory === 'all'
    ? products
    : products.filter((p) => p.categoryPath?.[1] === subcategory);

  const preflight = useMemo(
    () => buildPricingPreflight(products, selectedIds, delta),
    [products, selectedIds, delta],
  );
  const preflightSignature = JSON.stringify([preflight.percent, preflight.rows.map((row) => [row.id, row.oldPrice, row.newPrice])]);
  const reviewIsCurrent = reviewedSignature === preflightSignature;
  const selectedVisibleCount = visible.filter((product) => selectedIds.includes(product.id)).length;

  const toggleSelectAll = () => {
    const visibleIds = new Set(visible.map((product) => product.id));
    setReviewedSignature('');
    setConfirmation('');
    if (selectedVisibleCount === visible.length) {
      setSelectedIds((current) => current.filter((id) => !visibleIds.has(id)));
      return;
    }
    setSelectedIds((current) => [...new Set([...current, ...visibleIds])]);
  };

  const applyPricing = async () => {
    if (preflight.blocked) {
      toast(preflight.blockers[0], 'error');
      return;
    }
    if (!reviewIsCurrent) {
      toast('Review the exact before-and-after prices before applying', 'error');
      return;
    }
    if (preflight.highRisk && confirmation.trim() !== preflight.confirmationPhrase) {
      toast('Type the confirmation phrase exactly before applying this high-impact change', 'error');
      return;
    }
    setSaving(true);
    try {
      const selectedById = new Map(products.map((product) => [product.id, product]));
      const allSelected = preflight.rows.map((row) => ({ ...selectedById.get(row.id), nextPrice: row.newPrice }));
      // allSettled so one failed save doesn't mask the ones that succeeded.
      const outcomes = await Promise.allSettled(allSelected.map((p) => updateProduct(p.id, {
        price: p.nextPrice,
      })));
      const failedCount = outcomes.filter((o) => o.status === 'rejected').length;
      const selected = allSelected.filter((_, i) => outcomes[i].status === 'fulfilled');

      // Add newly-repriced items to This Week's Specials (capped at 10).
      const nextSpecials = [...(specials || [])];
      const seen = new Set(nextSpecials.map((s) => s.productId));
      for (const product of selected) {
        if (seen.has(product.id)) continue;
        if (nextSpecials.length >= 10) break;
        nextSpecials.push({
          productId: product.id,
          productName: product.name,
          productCode: product.code,
          productImage: product.image || '',
          deal: 'none',
          discountPct: 10,
          bogoX: 1,
          bogoY: 1,
        });
        seen.add(product.id);
      }
      if (nextSpecials.length !== (specials || []).length) {
        await saveSpecials(nextSpecials);
        onSpecialsChange?.(nextSpecials);
      }
      await load(category);
      setReviewedSignature('');
      setConfirmation('');
      setSelectedIds([]);
      if (failedCount > 0) {
        toast(`Updated ${selected.length} price(s), ${failedCount} failed — reload and retry the rest`, 'error');
      } else {
        toast(`Updated ${selected.length} product price(s) — added to This Week's Specials`);
      }
    } catch (err) {
      toast(err.message || 'Pricing update failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title">Pricing</h2>
          <p className="adm-section-note">Select products and apply a percentage price adjustment.</p>
        </div>
      </div>
      <div className="adm-toolbar" style={{ gridTemplateColumns: '1fr 1fr auto auto' }}>
        <select
          aria-label="Pricing category"
          value={category}
          onChange={(e) => { setCategory(e.target.value); setSubcategory('all'); setSelectedIds([]); }}
          className="adm-select"
        >
          {mainCategories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select
          aria-label="Pricing subcategory"
          value={subcategory}
          onChange={(e) => { setSubcategory(e.target.value); setSelectedIds([]); }}
          className="adm-select"
        >
          <option value="all">All subcategories</option>
          {subcategoryOptionsFromTree(taxonomyTree, category).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={toggleSelectAll}
          className="adm-btn-ghost"
          disabled={loading}
        >
          {visible.length > 0 && selectedVisibleCount === visible.length ? 'Clear visible' : 'Select visible'}
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            aria-label="Percentage price adjustment"
            inputMode="decimal"
            value={delta}
            onChange={(e) => { setDelta(e.target.value); setReviewedSignature(''); setConfirmation(''); }}
            className="adm-tiny-input"
            placeholder="-10"
          />
          <button
            type="button"
            onClick={() => {
              if (preflight.blocked) {
                toast(preflight.blockers[0], 'error');
                return;
              }
              if (!reviewIsCurrent) {
                setReviewedSignature(preflightSignature);
                setConfirmation('');
                return;
              }
              void applyPricing();
            }}
            className="adm-btn-red"
            disabled={saving}
          >
            {saving ? 'Applying…' : reviewIsCurrent ? 'Apply reviewed prices' : 'Review changes'}
          </button>
        </div>
      </div>
      {reviewIsCurrent && !preflight.blocked && (
        <section className="adm-pricing-preflight" aria-labelledby="pricing-preflight-title">
          <div>
            <h3 id="pricing-preflight-title">Price change preflight</h3>
            <p>
              {preflight.rows.length} product{preflight.rows.length === 1 ? '' : 's'} · {preflight.percent}% ·{' '}
              R{preflight.oldTotal.toFixed(2)} → R{preflight.newTotal.toFixed(2)}{' '}
              ({preflight.difference >= 0 ? '+' : ''}R{preflight.difference.toFixed(2)})
            </p>
          </div>
          <div className="adm-pricing-preflight-list" role="list" aria-label="Proposed product price changes">
            {preflight.rows.map((row) => (
              <div key={row.id} className="adm-pricing-preflight-row" role="listitem">
                <strong>{row.code}</strong>
                <span>{row.name}</span>
                <span>R{row.oldPrice.toFixed(2)} → <strong>R{row.newPrice.toFixed(2)}</strong></span>
              </div>
            ))}
          </div>
          {preflight.highRisk && (
            <label className="adm-field">
              <span className="adm-field-label">High-impact change — type <strong>{preflight.confirmationPhrase}</strong></span>
              <input
                className="adm-field-input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck="false"
              />
            </label>
          )}
        </section>
      )}
      <div className="adm-checkbox-list">
        {visible.map((product) => (
          <label
            key={product.id}
            className={`adm-checkbox-row${selectedIds.includes(product.id) ? ' adm-checkbox-row--pricing-selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(product.id)}
              onChange={(e) => {
                setReviewedSignature('');
                setConfirmation('');
                setSelectedIds((prev) => (
                  e.target.checked ? [...prev, product.id] : prev.filter((id) => id !== product.id)
                ));
              }}
            />
            <span style={{ fontWeight: 700 }}>{product.name}</span>
            <small className="adm-muted">
              {product.code}{product.price > 0 ? ` · R${Number(product.price).toFixed(2)}` : ''}
            </small>
          </label>
        ))}
        {loading && (
          <p className="adm-muted" style={{ padding: 12 }}>Loading products…</p>
        )}
        {!loading && !visible.length && (
          <p className="adm-muted" style={{ padding: 12 }}>No products in this selection.</p>
        )}
      </div>
    </div>
  );
}
