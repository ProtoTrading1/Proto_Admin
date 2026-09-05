import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { addPlacement, fetchPlacements, placementTrail, removePlacement } from '../lib/placements';
import { resolvePathLabels } from './CategorySidebar';
import { queryClient } from '../lib/queryClient';
import { invalidateAdminCache } from '../lib/products';

/**
 * View and edit the EXTRA categories a product appears under.
 *
 * The primary category is shown read-only for context — it is edited with the
 * normal category controls, and the API rejects adding a placement equal to it.
 *
 * The cascading selects are owned here rather than reusing the Product
 * Loader's CategoryPathSelect: that component renders bare <label> elements
 * styled by the loader's own CSS, and depending on someone else's markup for
 * a control this fiddly made a broken selection impossible to diagnose.
 */

function childrenOf(tree, id) {
  if (!id) return [];
  const stack = [...(tree || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.id === id) return node.children || [];
    if (node.children?.length) stack.push(...node.children);
  }
  return [];
}

export default function PlacementsEditor({ websiteSku, taxonomyTree = [] }) {
  const [placements, setPlacements] = useState([]);
  const [primaryPath, setPrimaryPath] = useState([]);
  const [draft, setDraft] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!websiteSku) return;
    setLoading(true);
    setError('');
    try {
      const data = await fetchPlacements(websiteSku);
      setPlacements(data.placements);
      setPrimaryPath(data.primaryPath);
    } catch (err) {
      setError(err.message || 'Could not load placements');
    } finally {
      setLoading(false);
    }
  }, [websiteSku]);

  useEffect(() => { void load(); }, [load]);

  // The product row behind this modal renders its category badge from the
  // catalogue query. Without this the save succeeds but the row keeps showing
  // the old categories, which reads as "nothing happened".
  const refreshCatalogue = () => {
    invalidateAdminCache();
    queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const onAdd = async () => {
    if (busy) return;
    if (!draft.length) {
      setError('Pick a category first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setPlacements(await addPlacement(websiteSku, draft));
      setDraft([]);
      refreshCatalogue();
    } catch (err) {
      setError(err.message || 'Could not add that location');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (placement) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setPlacements(await removePlacement(websiteSku, { id: placement.id }));
      refreshCatalogue();
    } catch (err) {
      setError(err.message || 'Could not remove that location');
    } finally {
      setBusy(false);
    }
  };

  // One select per level, plus an empty one below the deepest choice.
  const levels = [{ options: taxonomyTree || [], selected: draft[0] || '' }];
  for (let i = 0; i < draft.length; i += 1) {
    const options = childrenOf(taxonomyTree, draft[i]);
    if (!options.length) break;
    levels.push({ options, selected: draft[i + 1] || '' });
  }

  const setLevel = (index, id) => {
    setError('');
    setDraft(id ? [...draft.slice(0, index), id] : draft.slice(0, index));
  };

  const draftTrail = draft.length ? resolvePathLabels(taxonomyTree, draft).join(' › ') : '';
  const selectStyle = {
    width: '100%', padding: '6px 8px', borderRadius: 6,
    border: '1px solid #cbd5e1', fontSize: 13, background: '#fff',
  };

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#fff' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Also appears in
      </div>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 8, fontSize: 12, color: '#b91c1c', fontWeight: 600,
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 6, padding: '7px 9px',
          }}
        >
          {error}
        </div>
      )}
      <div className="adm-muted" style={{ fontSize: 11, marginTop: 4 }}>
        Primary: {primaryPath.length ? resolvePathLabels(taxonomyTree, primaryPath).join(' › ') : 'Uncategorised'}
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 10, color: '#64748b' }}>
          <Loader2 size={14} className="spin" /> Loading…
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!placements.length && (
            <div className="adm-muted" style={{ fontSize: 12 }}>Only in its primary category.</div>
          )}
          {placements.map((placement) => (
            <div
              key={placement.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                background: placement.orphaned ? '#fef2f2' : '#f8fafc',
                border: `1px solid ${placement.orphaned ? '#fecaca' : '#e2e8f0'}`,
                borderRadius: 8, padding: '5px 8px',
              }}
            >
              <span style={{ flex: 1, color: placement.orphaned ? '#b91c1c' : '#334155' }}>
                {placementTrail(placement)}
                {placement.orphaned && (
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700 }}>category deleted — remove this</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => void onRemove(placement)}
                disabled={busy}
                className="adm-btn-ghost"
                aria-label={`Remove ${placementTrail(placement)}`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12, borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
          Add another location
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {levels.map((level, index) => (
            <select
              key={index}
              value={level.selected}
              onChange={(e) => setLevel(index, e.target.value)}
              style={selectStyle}
            >
              <option value="">
                {index === 0 ? '— Choose a category —' : '— Optional subcategory —'}
              </option>
              {level.options.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          ))}
        </div>

        {draftTrail && (
          <div style={{ fontSize: 12, color: '#0369a1', marginTop: 8 }}>
            Will be added to: <strong>{draftTrail}</strong>
          </div>
        )}

        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={busy}
          style={{
            marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid #0369a1',
            background: draft.length ? '#0369a1' : '#e2e8f0',
            color: draft.length ? '#fff' : '#64748b',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          Add location
        </button>
      </div>

    </div>
  );
}
