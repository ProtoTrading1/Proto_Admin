import { X } from 'lucide-react';
import { allNodesFlat } from '../lib/taxonomyTreeUtils';

/**
 * Shared taxonomy create/rename/delete modals used by Product Manager and Reorder Grid.
 * State and save handlers live in AdminPage; this component is presentation only.
 */
export default function TaxonomyModals({
  taxonomyTree = [],
  editModal,
  deleteModal,
  newSubModal,
  newCategoryModal,
  saving = false,
  onCloseEdit,
  onCloseDelete,
  onCloseNewSub,
  onCloseNewCategory,
  onEditLabelChange,
  onNewSubParentChange,
  onNewSubLabelChange,
  onNewCategoryLabelChange,
  onSaveRename,
  onConfirmDelete,
  onSaveNewSub,
  onSaveNewCategory,
}) {
  return (
    <>
      {editModal && (
        <div className="adm-modal-backdrop" onClick={onCloseEdit}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Rename {editModal.type === 'category' ? 'category' : 'subcategory'}</h3>
              <button type="button" className="adm-modal-close" onClick={onCloseEdit} aria-label="Close"><X size={18} /></button>
            </div>
            <p className="adm-modal-note">The ID stays the same — only the display name and database labels update.</p>
            <div className="adm-modal-body">
              <label className="adm-field">
                <span className="adm-field-label">Name</span>
                <input
                  value={editModal.label}
                  onChange={(e) => onEditLabelChange(e.target.value)}
                  className="adm-field-input"
                  autoFocus
                />
              </label>
            </div>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={onCloseEdit}>Cancel</button>
                <button type="button" className="adm-btn-red" onClick={() => void onSaveRename()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteModal && (
        <div className="adm-modal-backdrop" onClick={onCloseDelete}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Delete {deleteModal.type === 'category' ? 'category' : 'subcategory'}?</h3>
              <button type="button" className="adm-modal-close" onClick={onCloseDelete} aria-label="Close"><X size={18} /></button>
            </div>
            <p className="adm-modal-note">
              Remove <strong>{deleteModal.label}</strong> from the catalogue structure.
              {deleteModal.productCount > 0
                ? ` ${deleteModal.productCount} product(s) will be moved to the Archive — restore them to live from there anytime.`
                : ' No products are assigned to it.'}
              {String(deleteModal.id || '').startsWith('mottaro') && (
                <><br /><span className="adm-muted">This is a Motarro subcategory. Its products are Motarro-branded items that also sit in a normal department — archiving removes them from <strong>both</strong> places. You can undo the deletion with “Restore deleted” while browsing Motarro.</span></>
              )}
            </p>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={onCloseDelete}>Cancel</button>
                <button type="button" className="adm-btn-red" onClick={() => void onConfirmDelete()} disabled={saving}>
                  {saving ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {newSubModal && (
        <div className="adm-modal-backdrop" onClick={onCloseNewSub}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Add child category</h3>
              <button type="button" className="adm-modal-close" onClick={onCloseNewSub} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="adm-modal-body">
              <label className="adm-field">
                <span className="adm-field-label">Under</span>
                <select
                  value={newSubModal.parentId}
                  onChange={(e) => onNewSubParentChange(e.target.value)}
                  className="adm-field-input"
                >
                  {allNodesFlat(taxonomyTree).map(({ id, label, depth }) => (
                    <option key={id} value={id}>{'  '.repeat(depth * 2)}{depth > 0 ? '└ ' : ''}{label}</option>
                  ))}
                </select>
              </label>
              <label className="adm-field">
                <span className="adm-field-label">Subcategory name</span>
                <input
                  value={newSubModal.label}
                  onChange={(e) => onNewSubLabelChange(e.target.value)}
                  className="adm-field-input"
                  placeholder="e.g. Seasonal Items"
                  autoFocus
                />
              </label>
            </div>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={onCloseNewSub}>Cancel</button>
                <button type="button" className="adm-btn-red" onClick={() => void onSaveNewSub()} disabled={saving}>
                  {saving ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {newCategoryModal && (
        <div className="adm-modal-backdrop" onClick={onCloseNewCategory}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">New category</h3>
              <button type="button" className="adm-modal-close" onClick={onCloseNewCategory} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="adm-modal-body">
              <label className="adm-field">
                <span className="adm-field-label">Category name</span>
                <input
                  value={newCategoryModal.label}
                  onChange={(e) => onNewCategoryLabelChange(e.target.value)}
                  className="adm-field-input"
                  placeholder="e.g. Outdoor & Camping"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') void onSaveNewCategory(); }}
                />
              </label>
            </div>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={onCloseNewCategory}>Cancel</button>
                <button type="button" className="adm-btn-red" onClick={() => void onSaveNewCategory()} disabled={saving}>
                  {saving ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
