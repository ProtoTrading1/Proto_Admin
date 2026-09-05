import { useEffect, useMemo, useState } from 'react';
import { Image, Loader2, Plus, X } from 'lucide-react';
import { setLiveTaxonomyTree, updateProduct } from '../lib/products';
import SellingUnitField from './SellingUnitField';
import {
  childrenOfTree,
  createSubcategory,
  fetchTaxonomy,
  subcategoryOptionsFromTree,
} from '../lib/taxonomyAdmin';

function withCurrentOption(options, currentId) {
  if (!currentId || options.some((o) => o.id === currentId)) return options;
  return [{ id: currentId, label: `${currentId} (missing)` }, ...options];
}

function findNodePath(tree, targetId, path = []) {
  for (const node of tree || []) {
    if (node.id === targetId) return path;
    if (node.children?.length) {
      const found = findNodePath(node.children, targetId, [...path, node.id]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * After creating a subcategory, return category field patch for the new node.
 * parentPath is the ancestors of parentId (root..parentId's parent), so the
 * full path down to the newly created node is [...parentPath, parentId, newId].
 */
function categoryPatchAfterNewSub(parentId, newId, tree) {
  const parentPath = findNodePath(tree, parentId) || [];
  const fullPath = [...parentPath, parentId, newId];
  return {
    categoryId: fullPath[0],
    childIds: fullPath.slice(1),
  };
}

function deepestCategoryParent(row) {
  const childIds = row.childIds || [];
  return childIds[childIds.length - 1] || row.categoryId || '';
}

function productToRow(product, tree) {
  const path = product.categoryPath || [];
  return {
    sku: product.sku || product.id,
    title: product.title || product.name || product.sku,
    image: product.image || product.images?.[0] || '',
    description: product.description || '',
    packDescription: product.packDescription || '',
    unitsOfIssue: product.unitsOfIssue || 'EACH',
    code: product.code || product.barcode || '',
    categoryId: path[0] || tree[0]?.id || '',
    childIds: path.slice(1).filter(Boolean),
  };
}

function categoryPathFromRow(row) {
  return [row.categoryId, ...(row.childIds || [])].filter(Boolean);
}

function rowSnapshot(row) {
  return {
    description: row.description,
    packDescription: row.packDescription,
    unitsOfIssue: row.unitsOfIssue,
    code: row.code,
    sku: row.sku,
    categoryPath: categoryPathFromRow(row),
  };
}

function buildPayload(original, row) {
  const payload = {};
  if (row.description !== original.description) payload.description = row.description;
  if (row.packDescription !== original.packDescription) payload.packDescription = row.packDescription;
  if (row.unitsOfIssue !== original.unitsOfIssue) payload.unitsOfIssue = row.unitsOfIssue;
  if (row.code !== original.code) payload.code = row.code;
  if (row.sku !== original.sku) payload.newWebsiteSku = row.sku;

  const newPath = categoryPathFromRow(row);
  const pathChanged = JSON.stringify(newPath) !== JSON.stringify(original.categoryPath);
  if (pathChanged) {
    if (!newPath.length) throw new Error('Every product needs a main category');
    payload.categoryPath = newPath;
  }
  return payload;
}

function CategoryFields({
  tree,
  row,
  onChange,
  compact = false,
  onCreateSubcategory,
}) {
  const childIds = row.childIds || [];
  // Level 1 & 2 always render once a main category is picked (most products
  // are categorised at least that deep); level 3+ is dynamic — as deep as
  // the taxonomy tree goes — rendering only while there are options to pick
  // or a stale value to preserve, disabled while its parent is unset.
  const child1Options = withCurrentOption(subcategoryOptionsFromTree(tree, row.categoryId), childIds[0] || '');
  const child2Options = withCurrentOption(childrenOfTree(tree, childIds[0]), childIds[1] || '');
  const deeperFields = [];
  {
    let parentId = childIds[1] || '';
    for (let level = 3; ; level += 1) {
      const currentValue = childIds[level - 1] || '';
      const options = withCurrentOption(childrenOfTree(tree, parentId), currentValue);
      if (!options.length && !currentValue) break;
      deeperFields.push({ level, options, currentValue, parentSet: !!parentId });
      parentId = currentValue;
    }
  }
  const createParentId = deepestCategoryParent(row);

  const setLevel = (level, value) => onChange({
    childIds: [...childIds.slice(0, level - 1), value].filter(Boolean),
  });

  return (
    <div className={`pm-bulk-cat${compact ? ' pm-bulk-cat--compact' : ''}`}>
      <label className="pm-bulk-field">
        <span>Main category</span>
        <select
          value={row.categoryId}
          onChange={(e) => onChange({ categoryId: e.target.value, childIds: [] })}
          className="adm-select adm-select--enhanced"
        >
          {tree.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>

      {row.categoryId && (
        <>
          <label className="pm-bulk-field">
            <span>Child category 1</span>
            <select
              value={childIds[0] || ''}
              onChange={(e) => setLevel(1, e.target.value)}
              className="adm-select adm-select--enhanced"
            >
              <option value="">— None —</option>
              {child1Options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>

          <label className="pm-bulk-field">
            <span>Child category 2</span>
            <select
              value={childIds[1] || ''}
              disabled={!childIds[0]}
              onChange={(e) => setLevel(2, e.target.value)}
              className="adm-select adm-select--enhanced"
              title={!childIds[0] ? 'Select child category 1 first' : undefined}
            >
              <option value="">— None —</option>
              {child2Options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>

          {deeperFields.map(({ level, options, currentValue, parentSet }) => (
            <label className="pm-bulk-field" key={level}>
              <span>Child category {level}</span>
              <select
                value={currentValue}
                disabled={!parentSet}
                onChange={(e) => setLevel(level, e.target.value)}
                className="adm-select adm-select--enhanced"
                title={!parentSet ? `Select child category ${level - 1} first` : undefined}
              >
                <option value="">— None —</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          ))}
        </>
      )}

      {onCreateSubcategory && row.categoryId && (
        <div className="pm-bulk-cat-create">
          <button
            type="button"
            className="adm-modal-link-btn adm-modal-link-btn--add pm-bulk-cat-create-btn"
            onClick={() => onCreateSubcategory(createParentId)}
          >
            <Plus size={14} strokeWidth={2.5} /> New child category
          </button>
        </div>
      )}
    </div>
  );
}

function allNodesFlat(nodes, depth = 0) {
  return (nodes || []).flatMap((n) => [
    { id: n.id, label: n.label, depth },
    ...allNodesFlat(n.children, depth + 1),
  ]);
}

function NewSubcategoryModal({ tree, parentId, onClose, onCreated, saving }) {
  const [label, setLabel] = useState('');
  const [selectedParent, setSelectedParent] = useState(parentId || tree[0]?.id || '');
  const flatNodes = useMemo(() => allNodesFlat(tree), [tree]);

  return (
    <div className="adm-modal-backdrop pm-bulk-sub-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal adm-modal--form pm-bulk-sub-modal" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-header">
          <h3 className="adm-modal-title">Add child category</h3>
          <button type="button" className="adm-modal-close" onClick={onClose} disabled={saving} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="adm-modal-body">
          <label className="adm-field">
            <span className="adm-field-label">Under</span>
            <select
              value={selectedParent}
              onChange={(e) => setSelectedParent(e.target.value)}
              className="adm-field-input"
              disabled={saving}
            >
              {flatNodes.map(({ id, label: nodeLabel, depth }) => (
                <option key={id} value={id}>
                  {' '.repeat(depth * 2)}{depth > 0 ? '└ ' : ''}{nodeLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-field">
            <span className="adm-field-label">Subcategory name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="adm-field-input"
              placeholder="e.g. Extension Leads"
              autoFocus
              disabled={saving}
            />
          </label>
        </div>
        <div className="adm-modal-footer adm-modal-footer--end">
          <div className="adm-modal-footer__actions">
            <button type="button" className="adm-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              type="button"
              className="adm-btn-red"
              disabled={saving || !label.trim() || !selectedParent}
              onClick={() => onCreated({ parentId: selectedParent, label: label.trim() })}
            >
              {saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BulkProductEditModal({
  products = [],
  taxonomyTree = [],
  onClose,
  onSaved,
  onShowToast,
  onRefreshTaxonomy,
}) {
  const [tree, setTree] = useState(taxonomyTree);
  const [rows, setRows] = useState(() => products.map((p) => productToRow(p, taxonomyTree)));
  const originals = useMemo(
    () => products.map((p) => rowSnapshot(productToRow(p, taxonomyTree))),
    [products, taxonomyTree],
  );
  const [saving, setSaving] = useState(false);
  const [taxonomySaving, setTaxonomySaving] = useState(false);
  const [newSub, setNewSub] = useState(null);

  useEffect(() => {
    setTree(taxonomyTree);
  }, [taxonomyTree]);

  const refreshTree = async () => {
    const next = await fetchTaxonomy();
    setTree(next);
    setLiveTaxonomyTree(next);
    await onRefreshTaxonomy?.();
    return next;
  };

  const openCreateSub = (parentId, target) => {
    setNewSub({ parentId, target });
  };

  const handleCreateSub = async ({ parentId, label }) => {
    setTaxonomySaving(true);
    try {
      const json = await createSubcategory(parentId, label);
      const nextTree = await refreshTree();
      const newId = json.node?.id;
      if (newId && typeof newSub?.target === 'number') {
        const patch = categoryPatchAfterNewSub(parentId, newId, nextTree);
        patchRow(newSub.target, patch);
      }
      setNewSub(null);
      onShowToast?.(json.created ? 'Child category created' : 'Category already exists — selected it for you', 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Create failed', 'error');
    } finally {
      setTaxonomySaving(false);
    }
  };

  const patchRow = (index, patch) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleSave = async () => {
    setSaving(true);
    setLiveTaxonomyTree(tree);
    let saved = 0;
    let skipped = 0;
    let relinked = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const original = originals[i];
      try {
        const payload = buildPayload(original, row);
        if (!Object.keys(payload).length) {
          skipped += 1;
          continue;
        }
        const result = await updateProduct(original.sku, payload);
        if (result?.relink?.matched) relinked += 1;
        saved += 1;
      } catch (err) {
        errors.push(`${row.title || row.sku}: ${err.message}`);
      }
    }

    setSaving(false);

    if (errors.length && saved === 0) {
      onShowToast?.(`Save failed — ${errors[0]}`, 'error');
      return;
    }

    if (errors.length) {
      onShowToast?.(`${saved} saved, ${errors.length} failed`, 'warning');
    } else if (saved === 0) {
      onShowToast?.('No changes to save', 'warning');
      return;
    } else if (relinked > 0) {
      onShowToast?.(
        `${saved} product${saved === 1 ? '' : 's'} saved — ${relinked} matched to Positill; refresh Archive to see live stock`,
        'success',
      );
    } else {
      onShowToast?.(`${saved} product${saved === 1 ? '' : 's'} saved`, 'success');
    }

    onSaved?.({ saved, skipped, errors });
    if (!errors.length) onClose?.();
  };

  return (
    <>
      <div className="adm-modal-backdrop" onClick={() => !saving && !taxonomySaving && onClose?.()}>
        <div className="adm-modal adm-modal--form pm-bulk-edit-modal" onClick={(e) => e.stopPropagation()}>
          <div className="adm-modal-header">
            <h3 className="adm-modal-title">Bulk edit {rows.length} product{rows.length === 1 ? '' : 's'}</h3>
            <button type="button" className="adm-modal-close" onClick={onClose} disabled={saving} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <p className="adm-modal-note">
            Edit descriptions, pack size, barcode, website SKU, and category placement per product.
            Use child categories 1–3 for the full path. Changes save when you click Save all.
          </p>

          <div className="adm-modal-body pm-bulk-edit-body">
            {rows.map((row, index) => (
              <article key={originals[index].sku} className="pm-bulk-edit-card">
                <header className="pm-bulk-edit-card-head">
                  {row.image ? (
                    <img src={row.image} alt="" className="adm-product-thumb" />
                  ) : (
                    <div className="adm-product-thumb adm-product-thumb--placeholder"><Image size={14} /></div>
                  )}
                  <div className="pm-bulk-edit-card-title">
                    <strong>{row.title}</strong>
                    <span className="adm-muted">Current WSK: {originals[index].sku}</span>
                  </div>
                </header>

                <div className="pm-bulk-edit-fields">
                  <label className="pm-bulk-field">
                    <span>Website SKU (WSK)</span>
                    <input
                      type="text"
                      className="adm-field-input"
                      value={row.sku}
                      onChange={(e) => patchRow(index, { sku: e.target.value.trim() })}
                    />
                  </label>
                  <label className="pm-bulk-field">
                    <span>Barcode / product code</span>
                    <input
                      type="text"
                      className="adm-field-input"
                      value={row.code}
                      onChange={(e) => patchRow(index, { code: e.target.value })}
                    />
                  </label>
                  <label className="pm-bulk-field pm-bulk-field--wide">
                    <span>Pack description</span>
                    <input
                      type="text"
                      className="adm-field-input"
                      value={row.packDescription}
                      onChange={(e) => patchRow(index, { packDescription: e.target.value })}
                      placeholder="Pack size, carton qty…"
                    />
                  </label>
                  <div className="pm-bulk-field pm-bulk-field--wide">
                    <SellingUnitField
                      value={row.unitsOfIssue}
                      onChange={(unitsOfIssue) => patchRow(index, { unitsOfIssue })}
                      id={`bulk-selling-unit-options-${index}`}
                    />
                  </div>
                  <label className="pm-bulk-field pm-bulk-field--full">
                    <span>Description</span>
                    <textarea
                      className="adm-field-input"
                      rows={3}
                      value={row.description}
                      onChange={(e) => patchRow(index, { description: e.target.value })}
                      style={{ resize: 'vertical', fontFamily: 'inherit' }}
                    />
                  </label>
                </div>

                <div className="pm-bulk-edit-cat-section">
                  <span className="pm-bulk-edit-cat-label">Category placement</span>
                  <CategoryFields
                    tree={tree}
                    row={row}
                    onChange={(patch) => patchRow(index, patch)}
                    compact
                    onCreateSubcategory={(parentId) => openCreateSub(parentId, index)}
                  />
                </div>
              </article>
            ))}
          </div>

          <div className="adm-modal-footer adm-modal-footer--end">
            <div className="adm-modal-footer__actions">
              <button type="button" className="adm-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="adm-btn-red" onClick={() => void handleSave()} disabled={saving || taxonomySaving}>
                {saving ? <><Loader2 size={14} className="spin" /> Saving…</> : `Save all changes (${rows.length})`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {newSub && (
        <NewSubcategoryModal
          tree={tree}
          parentId={newSub.parentId}
          saving={taxonomySaving}
          onClose={() => !taxonomySaving && setNewSub(null)}
          onCreated={(payload) => void handleCreateSub(payload)}
        />
      )}
    </>
  );
}
