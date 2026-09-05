import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { resolvePathLabels } from './CategorySidebar';
import { subcategoryOptionsFromTree } from '../lib/taxonomyAdmin';

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

export default function BulkMoveModal({
  open,
  count,
  taxonomyTree = [],
  initialCategoryId = '',
  saving = false,
  onClose,
  onConfirm,
  onAddSubcategory,
}) {
  const mainCategories = useMemo(
    () => (taxonomyTree || []).map((c) => ({ id: c.id, label: c.label })),
    [taxonomyTree],
  );

  const [moveCategoryId, setMoveCategoryId] = useState('');
  // ids for Child 1, Child 2, ... as deep as the taxonomy tree goes — no fixed
  // depth cap. Always a contiguous, non-empty prefix (see setMoveChildIds
  // callers below), so index i holds "Child category i+1"'s selection.
  const [moveChildIds, setMoveChildIds] = useState([]);

  useEffect(() => {
    if (!open) return;
    setMoveCategoryId(initialCategoryId || mainCategories[0]?.id || '');
    setMoveChildIds([]);
  }, [open, initialCategoryId, mainCategories]);

  if (!open) return null;

  // Render one picker per level for as long as the previous level has a
  // value AND there are options to choose — this naturally stops one level
  // past the deepest populated selection, offering exactly one empty picker
  // to go deeper (mirrors how child1Options.length > 0 gated the old fixed
  // Child 1..4 blocks, generalized to arbitrary depth).
  const childFields = [];
  {
    let parentId = moveCategoryId;
    for (let level = 1; parentId; level += 1) {
      const options = level === 1
        ? subcategoryOptionsFromTree(taxonomyTree, moveCategoryId)
        : childrenOf(taxonomyTree, parentId);
      if (!options.length) break;
      const currentValue = moveChildIds[level - 1] || '';
      childFields.push({ level, options, currentValue });
      parentId = currentValue;
    }
  }
  const deepestId = moveChildIds[moveChildIds.length - 1] || '';
  // Contiguous path only — never allow a gap (e.g. child2 empty while child3 is set).
  // The UI already truncates deeper selections when a parent changes, but we
  // assert it here so the server never sees a spliced [main, empty, sub2] path.
  const rawPath = [moveCategoryId, ...moveChildIds];
  const firstEmpty = rawPath.findIndex((seg) => !seg);
  const contiguousPath = firstEmpty === -1 ? rawPath : rawPath.slice(0, firstEmpty);
  const hasPathGap = rawPath.some((seg, i) => !seg && rawPath.slice(i + 1).some(Boolean));
  const movePreviewLabel = contiguousPath.length >= 2
    ? resolvePathLabels(taxonomyTree, contiguousPath).join(' › ')
    : 'Select a main category and subcategory';

  const handleConfirm = () => {
    if (hasPathGap) return;
    if (contiguousPath.length < 2) return;
    const categoryPathIds = contiguousPath;
    const finalSubId = categoryPathIds[categoryPathIds.length - 1];
    onConfirm?.({
      categoryPathIds,
      categoryId: moveCategoryId,
      subcategoryId: finalSubId,
      destinationLabel: movePreviewLabel,
    });
  };

  return (
    <div className="adm-modal-backdrop" onClick={onClose}>
      <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
        <div className="adm-modal-header">
          <h3 className="adm-modal-title">Move {count} product{count === 1 ? '' : 's'}</h3>
          <button type="button" className="adm-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <p className="adm-modal-note">Choose the destination category. Products update on the trade website immediately.</p>
        <p className="adm-modal-note" style={{ fontWeight: 700, color: '#334155' }}>
          Destination: {movePreviewLabel}
        </p>
        <div className="adm-modal-body">
          <label className="adm-field">
            <span className="adm-field-label">Main category</span>
            <select
              value={moveCategoryId}
              onChange={(e) => {
                setMoveCategoryId(e.target.value);
                setMoveChildIds([]);
              }}
              className="adm-select adm-select--enhanced"
            >
              {mainCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {childFields.map(({ level, options, currentValue }) => (
            <label className="adm-field" key={level}>
              <span className="adm-field-label">Child category {level}</span>
              <select
                value={currentValue}
                onChange={(e) => setMoveChildIds((ids) => [...ids.slice(0, level - 1), e.target.value].filter(Boolean))}
                className="adm-select adm-select--enhanced"
              >
                <option value="">— None —</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="adm-modal-footer">
          <button
            type="button"
            className="adm-modal-link-btn adm-modal-link-btn--add"
            onClick={() => onAddSubcategory?.(deepestId || moveCategoryId)}
          >
            <Plus size={15} strokeWidth={2.5} /> New subcategory
          </button>
          <div className="adm-modal-footer__actions">
            <button type="button" className="adm-btn-ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="adm-btn-red"
              onClick={handleConfirm}
              disabled={saving || contiguousPath.length < 2 || hasPathGap}
            >
              {saving ? 'Moving…' : 'Confirm move'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
