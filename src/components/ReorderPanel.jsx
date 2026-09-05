import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  ArrowLeftRight,
  Plus,
  Search,
  X,
} from 'lucide-react';
import ReorderGrid from './ReorderGrid';
import CategorySidebar, { resolvePathLabels } from './CategorySidebar';
import SectionErrorBoundary from './SectionErrorBoundary';
import {
  applyPathFilter,
  bulkArchiveProducts,
  bulkMoveProducts,
  fetchReorderProducts,
  invalidateAdminCache,
  invalidateProductCache,
  updateProduct,
} from '../lib/products';
import { fuzzyFilter } from '../lib/fuzzySearch';
import { LEGACY_NAV_ALIASES, sortOrderCategoryKey, sortOrderLookupKeys } from '../lib/taxonomy';
import { childrenOf, findNodePath, subcategoryOptions } from '../lib/taxonomyTreeUtils';
import { queryClient } from '../lib/queryClient';
import {
  applySortOrdersToProducts,
  fetchSortOrderStore,
  fetchSortMetaForCategory,
  formatSortSavedAt,
  invalidateSortOrderStore,
  persistSortOrder,
  sortMetaForPath,
} from '../lib/sortOrderStore';

const LARGE_BULK_MOVE_THRESHOLD = 100;

/** Merge a reordered visible slice back into the full product list (arrow-key reorder). */
function mergeVisibleReorder(prev, currentVisible, nextVisible) {
  if (nextVisible.length === prev.length) return nextVisible;
  const visibleIdSet = new Set(currentVisible.map((p) => p.id));
  if (nextVisible.length !== currentVisible.length) return prev;
  const result = [];
  let merged = false;
  for (const p of prev) {
    if (visibleIdSet.has(p.id)) {
      if (!merged) {
        result.push(...nextVisible);
        merged = true;
      }
    } else {
      result.push(p);
    }
  }
  return merged ? result : nextVisible;
}

const ReorderPanel = forwardRef(function ReorderPanel({
  isActive,
  taxonomyTree = [],
  categoryProductCounts = {},
  onCategoryReorder,
  onEditSubcategory,
  onDeleteSubcategory,
  onAddSubcategory,
  onEditProduct,
  onShowToast,
  onRefreshStats,
  onRefreshCategoryCounts,
}, ref) {
  const mainCategories = useMemo(
    () => taxonomyTree.map((item) => ({ id: item.id, label: item.label })),
    [taxonomyTree],
  );
  const firstMainCategoryId = mainCategories[0]?.id || '';

  const [categoryPath, setCategoryPath] = useState([]);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [sortMeta, setSortMeta] = useState({ updatedAt: null, storeUpdatedAt: null });
  const [loading, setLoading] = useState(false);
  const [loadingError, setLoadingError] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [saving, setSaving] = useState('');

  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveCategoryId, setMoveCategoryId] = useState('');
  // ids for Child 1, Child 2, ... as deep as the taxonomy tree goes — no fixed
  // depth cap. Always a contiguous, non-empty prefix.
  const [moveChildIds, setMoveChildIds] = useState([]);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [bulkFieldEditOpen, setBulkFieldEditOpen] = useState(false);
  const [bulkFieldEditType, setBulkFieldEditType] = useState('description');
  const [bulkFieldEditValue, setBulkFieldEditValue] = useState('');

  const storeUpdatedAtRef = useRef(null);
  // Per-category conflict tokens — a save of one category must never
  // invalidate another category's token (that was the source of the false
  // "Sort order changed elsewhere" errors).
  const categoryTokensRef = useRef(new Map());
  // Serialize saves so a second auto-save never races the first with a
  // stale token.
  const saveChainRef = useRef(Promise.resolve());
  const cacheByMainRef = useRef({});
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const mainId = categoryPath[0] || mainCategories[0]?.id || '';
  const navPath = categoryPath;
  const cacheKey = categoryPath.length ? mainId : '__all__';
  const browseAll = !categoryPath.length;
  const pathKey = categoryPath.join('/');
  const searchActive = search.trim().length > 0;

  const toast = useCallback((message, type = 'success') => {
    onShowToast?.(message, type);
  }, [onShowToast]);

  const mergeIntoCategoryCache = useCallback((all, visible, path) => {
    if (!path?.length) return visible;
    const visibleIds = new Set(visible.map((p) => p.id));
    const merged = [];
    let vi = 0;
    for (const p of all) {
      if (visibleIds.has(p.id)) {
        if (vi < visible.length) merged.push(visible[vi++]);
      } else {
        merged.push(p);
      }
    }
    while (vi < visible.length) merged.push(visible[vi++]);
    return merged;
  }, []);

  const productsForSortSave = useCallback((orderedProducts, groupId) => {
    if (groupId && !categoryPath.length) {
      return orderedProducts.filter((p) => {
        const main = p.categoryPath?.[0] || p.category || '';
        return main === groupId || LEGACY_NAV_ALIASES[main] === groupId;
      });
    }
    return applyPathFilter(orderedProducts, categoryPath);
  }, [categoryPath]);

  const applyReorderView = useCallback(async (allRows) => {
    const store = await fetchSortOrderStore();
    const filtered = applyPathFilter(allRows, navPath);
    const ordered = applySortOrdersToProducts(filtered, navPath, taxonomyTree, store);
    if (navPath.length) {
      const meta = sortMetaForPath(store, navPath, taxonomyTree);
      setSortMeta({ updatedAt: meta.updatedAt, storeUpdatedAt: store.updatedAt || null });
      storeUpdatedAtRef.current = store.updatedAt || null;
      const canonicalKey = sortOrderCategoryKey(navPath, taxonomyTree);
      if (canonicalKey) {
        categoryTokensRef.current.set(canonicalKey, store.orders?.[canonicalKey]?.updatedAt ?? null);
      }
    }
    setProducts((prev) => {
      if (prev.length === ordered.length && prev.every((p, i) => p.id === ordered[i]?.id)) return prev;
      return ordered;
    });
    return ordered;
  }, [navPath, taxonomyTree]);

  const loadProducts = useCallback(async ({ forceCatalog = false, mainId: loadMainId = mainId } = {}) => {
    const loadAll = !categoryPath.length;
    const key = loadAll ? '__all__' : loadMainId;
    if (!loadAll && !loadMainId) {
      setProducts([]);
      return;
    }
    const cached = cacheByMainRef.current[key];
    const firstLoad = !cached;
    if (firstLoad || forceCatalog) setLoading(true);
    setLoadingError('');
    try {
      if (!cached || forceCatalog) {
        cacheByMainRef.current[key] = await fetchReorderProducts({
          mainCategory: loadAll ? 'all' : loadMainId,
        });
      }
      await applyReorderView(cacheByMainRef.current[key]);
      setDirty(false);
    } catch (err) {
      setLoadingError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [categoryPath.length, mainId, applyReorderView]);

  const doCommitReorderOrder = useCallback(async (orderedProducts, { groupId } = {}) => {
    if (search.trim().length > 0) return;

    const savePath = groupId && !categoryPath.length ? [groupId] : navPath;
    if (!savePath.length) {
      toast('Select a category in the sidebar to save order', 'error');
      return;
    }

    const categoryKey = sortOrderCategoryKey(savePath, taxonomyTree);
    if (!categoryKey) return;

    const slice = productsForSortSave(orderedProducts, groupId);
    const skuOrder = slice.map((p) => p.id);
    if (!skuOrder.length) return;

    const legacyKeys = sortOrderLookupKeys(savePath, taxonomyTree).filter((k) => k !== categoryKey);
    const save = () => persistSortOrder({
      categoryKey,
      skuOrder,
      legacyKeys,
      expectedCategoryUpdatedAt: categoryTokensRef.current.get(categoryKey) ?? null,
    });

    setSavingOrder(true);
    try {
      let json;
      try {
        json = await save();
      } catch (err) {
        if (err.status !== 409) throw err;
        // Token was stale (e.g. another tab saved this category). The user's
        // latest drag is the intended order — refresh the token and retry
        // once before giving up.
        const meta = await fetchSortMetaForCategory(categoryKey);
        categoryTokensRef.current.set(categoryKey, err.categoryUpdatedAt || meta?.updatedAt || null);
        json = await save();
      }
      setSortMeta({ updatedAt: json.updatedAt, storeUpdatedAt: json.storeUpdatedAt || null });
      storeUpdatedAtRef.current = json.storeUpdatedAt || null;
      categoryTokensRef.current.set(categoryKey, json.categoryUpdatedAt || json.updatedAt || null);
      setDirty(false);
      if (mainId && cacheByMainRef.current[cacheKey]) {
        const cachePath = categoryPath.length ? categoryPath : [mainId];
        cacheByMainRef.current[cacheKey] = mergeIntoCategoryCache(
          cacheByMainRef.current[cacheKey],
          orderedProducts,
          cachePath,
        );
      }
    } catch (err) {
      if (err.status === 409) {
        toast('Someone else is editing this category right now — refreshing to the latest order', 'error');
        invalidateSortOrderStore();
        await loadProducts({ forceCatalog: true });
        return;
      }
      toast(err.message || 'Failed to save order', 'error');
      setDirty(true);
    } finally {
      setSavingOrder(false);
    }
  }, [search, categoryPath, navPath, mainId, cacheKey, taxonomyTree, productsForSortSave, mergeIntoCategoryCache, loadProducts, toast]);

  // Queue saves so an in-flight save always finishes (and refreshes the
  // conflict token) before the next one fires.
  const commitReorderOrder = useCallback((orderedProducts, meta) => {
    const run = () => doCommitReorderOrder(orderedProducts, meta);
    saveChainRef.current = saveChainRef.current.then(run, run);
    return saveChainRef.current;
  }, [doCommitReorderOrder]);

  const scheduleReorderSave = useCallback((orderedProducts, meta) => {
    pendingSaveRef.current = { orderedProducts, meta };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) void commitReorderOrder(pending.orderedProducts, pending.meta);
    }, 600);
  }, [commitReorderOrder]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isActive) return;
    if (!categoryPath.length && firstMainCategoryId) {
      setCategoryPath([firstMainCategoryId]);
      return;
    }
    if (!categoryPath.length) return;

    const cached = cacheByMainRef.current[cacheKey];
    if (cached) {
      void applyReorderView(cached);
      return;
    }
    void loadProducts();
  }, [isActive, cacheKey, pathKey, firstMainCategoryId, categoryPath.length, applyReorderView, loadProducts]);

  const visibleProducts = useMemo(() => {
    const q = search.trim();
    if (q) return fuzzyFilter(products, q);
    return applyPathFilter(products, navPath);
  }, [products, navPath, search]);

  const handleProductsChange = useCallback((nextOrFn) => {
    setProducts((prev) => {
      if (typeof nextOrFn === 'function') return nextOrFn(prev);
      const pathFiltered = applyPathFilter(prev, navPath);
      const q = search.trim();
      const currentVisible = q ? fuzzyFilter(pathFiltered, q) : pathFiltered;
      return mergeVisibleReorder(prev, currentVisible, nextOrFn);
    });
    setDirty(true);
  }, [navPath, search]);

  const saveReorderOrder = async () => {
    if (searchActive) {
      toast('Clear search before saving sort order', 'error');
      return;
    }
    await commitReorderOrder(products);
    toast('Sort order saved to live site', 'success');
  };

  const toggleSelectAll = () => {
    const ids = visibleProducts.map((p) => p.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(ids));
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openMoveModal = () => {
    setMoveCategoryId(mainId || mainCategories[0]?.id || '');
    setMoveChildIds([]);
    setMoveModalOpen(true);
  };

  const confirmBulkMove = async () => {
    const categoryPathIds = [moveCategoryId, ...moveChildIds].filter(Boolean);
    const finalSubId = moveChildIds[moveChildIds.length - 1] || '';
    if (!selectedIds.size || categoryPathIds.length < 2) {
      toast('Choose a main category and at least one subcategory', 'error');
      return;
    }
    const destinationLabel = resolvePathLabels(taxonomyTree, categoryPathIds).join(' › ');
    if (!window.confirm(`Move ${selectedIds.size} product(s) to:\n${destinationLabel}?`)) return;
    setSaving('bulk-move');
    const count = selectedIds.size;
    if (count > LARGE_BULK_MOVE_THRESHOLD) {
      toast(`Moving ${count} products…`, 'info');
    }
    try {
      await bulkMoveProducts({
        skus: [...selectedIds],
        categoryId: moveCategoryId,
        subcategoryId: finalSubId,
        categoryPathIds,
      });
      setMoveModalOpen(false);
      setSelectedIds(new Set());
      setCategoryPath(categoryPathIds);
      invalidateAdminCache();
      invalidateProductCache();
      await loadProducts({ forceCatalog: true, mainId: moveCategoryId });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void onRefreshCategoryCounts?.();
      toast(`Moved ${count} product(s) to ${destinationLabel}`);
    } catch (err) {
      if (err.partial && err.result?.moved) {
        setMoveModalOpen(false);
        setSelectedIds(new Set());
        invalidateAdminCache();
        queryClient.invalidateQueries({ queryKey: ['catalog'] });
        void loadProducts({ forceCatalog: true, mainId: moveCategoryId });
      }
      toast(err.message || 'Move failed', err.partial ? 'warning' : 'error');
    } finally { setSaving(''); }
  };

  const confirmBulkFieldEdit = async () => {
    if (!selectedIds.size || !bulkFieldEditValue.trim()) {
      toast('Enter a value to apply', 'error');
      return;
    }
    setSaving('bulk-field-edit');
    const skus = [...selectedIds];
    const field = bulkFieldEditType;
    const value = bulkFieldEditValue.trim();
    try {
      await Promise.all(skus.map((sku) => updateProduct(sku, { [field]: value })));
      const patch = { [field]: value };
      setProducts((prev) => prev.map((p) => (selectedIds.has(p.id) ? { ...p, ...patch } : p)));
      setBulkFieldEditOpen(false);
      setBulkFieldEditValue('');
      toast(`Updated ${skus.length} product(s)`);
    } catch (err) {
      toast(err.message || 'Bulk edit failed', 'error');
    } finally { setSaving(''); }
  };

  const confirmBulkArchive = async () => {
    const count = selectedIds.size;
    setSaving('bulk-archive');
    try {
      await bulkArchiveProducts([...selectedIds]);
      invalidateAdminCache();
      invalidateProductCache();
      setArchiveConfirmOpen(false);
      setSelectedIds(new Set());
      onRefreshStats?.();
      await loadProducts();
      toast(`Archived ${count} product(s)`);
    } catch (err) {
      toast(err.message || 'Archive failed', 'error');
    } finally { setSaving(''); }
  };

  const moveSelectedToTop = () => {
    if (!selectedIds.size) return;
    setProducts((prev) => {
      const moving = prev.filter((p) => selectedIds.has(p.id));
      const rest = prev.filter((p) => !selectedIds.has(p.id));
      return [...moving, ...rest];
    });
    setDirty(true);
    setSelectedIds(new Set());
  };

  const applySubcategoryCreated = useCallback((json, parentId) => {
    if (!json.node?.id) return;
    // Ancestors of parentId (root..parentId's parent), so the full path down
    // to the newly created node is [...parentPath, parentId, newId].
    const parentPath = findNodePath(taxonomyTree, parentId) || [];
    const newId = json.node.id;
    const fullPath = [...parentPath, parentId, newId];
    setMoveCategoryId(fullPath[0]);
    setMoveChildIds(fullPath.slice(1));
    if (selectedIdsRef.current.size > 0) setMoveModalOpen(true);
  }, [taxonomyTree]);

  const onPathNodeDeleted = useCallback((nodeId) => {
    setCategoryPath((prev) => prev.filter((id) => id !== nodeId));
    void loadProducts();
  }, [loadProducts]);

  const patchProduct = useCallback((productId, patch) => {
    setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, ...patch } : p)));
  }, []);

  useImperativeHandle(ref, () => ({
    refresh: () => loadProducts(),
    applySubcategoryCreated,
    onPathNodeDeleted,
    patchProduct,
  }), [loadProducts, applySubcategoryCreated, onPathNodeDeleted, patchProduct]);

  // Render one picker per level for as long as the previous level has a
  // value AND there are options to choose — stops one level past the
  // deepest populated selection, offering exactly one empty picker to go
  // deeper. No fixed depth cap.
  const moveChildFields = [];
  {
    let parentId = moveCategoryId;
    for (let level = 1; parentId; level += 1) {
      const options = level === 1
        ? subcategoryOptions(moveCategoryId, taxonomyTree)
        : childrenOf(taxonomyTree, parentId);
      if (!options.length) break;
      const currentValue = moveChildIds[level - 1] || '';
      moveChildFields.push({ level, options, currentValue });
      parentId = currentValue;
    }
  }
  const deepestId = moveChildIds[moveChildIds.length - 1] || '';
  const movePreviewPath = [moveCategoryId, ...moveChildIds].filter(Boolean);
  const movePreviewLabel = movePreviewPath.length >= 2
    ? resolvePathLabels(taxonomyTree, movePreviewPath).join(' › ')
    : 'Select a main category and subcategory';

  return (
    <SectionErrorBoundary name="reorder-grid" title="Reorder Grid crashed" resetKey={cacheKey}>
      <div className="adm-panel adm-panel--reorder">
        {loadingError && (
          <div style={{ margin: '0 0 12px', padding: '10px 16px', background: '#fef2f2', borderRadius: 8, color: '#c40000', fontSize: 13, fontWeight: 600 }}>
            Error: {loadingError}
          </div>
        )}

        <div className="adm-section-head adm-section-head--reorder">
          <div>
            <h2 className="adm-section-title">Reorder Grid</h2>
            <p className="adm-section-note">Matches the live trade portal order (cached). Pick a category in the sidebar — drag to reorder within that category. Changes save automatically after you drop.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {sortMeta.updatedAt && formatSortSavedAt(sortMeta.updatedAt) && (
              <span className="adm-pill adm-pill--ok">
                Order saved · {formatSortSavedAt(sortMeta.updatedAt)}
              </span>
            )}
            <button
              type="button"
              onClick={() => void saveReorderOrder()}
              className="adm-btn-red"
              disabled={!dirty || savingOrder || searchActive}
            >
              {savingOrder ? 'Saving…' : 'Save order'}
            </button>
          </div>
        </div>

        <div className="adm-reorder-toolbar">
          <div className="adm-reorder-toolbar__filters">
            <label className="adm-search" style={{ minWidth: 220 }}>
              <Search size={14} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, barcode…"
                className="adm-search-input"
              />
              {searchActive && (
                <button
                  type="button"
                  className="adm-icon-btn"
                  onClick={() => setSearch('')}
                  title="Clear search"
                  style={{ padding: 2 }}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <span className="adm-reorder-count">
              {visibleProducts.length} {searchActive ? `match${visibleProducts.length === 1 ? '' : 'es'}` : 'live products'}
            </span>
            <button
              type="button"
              className="adm-btn-ghost adm-btn--sm"
              onClick={toggleSelectAll}
              disabled={!visibleProducts.length}
            >
              {visibleProducts.length > 0 && visibleProducts.every((p) => selectedIds.has(p.id))
                ? 'Deselect all'
                : `Select all (${visibleProducts.length})`}
            </button>
            {dirty && !searchActive && (
              <span className="adm-pill adm-pill--warn">Unsaved order</span>
            )}
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="adm-bulk-bar" role="region" aria-label="Bulk actions">
            <div className="adm-bulk-bar__left">
              <span className="adm-bulk-bar__badge">{selectedIds.size}</span>
              <span className="adm-bulk-bar__count">selected</span>
              <button type="button" className="adm-bulk-bar__link" onClick={toggleSelectAll}>
                {visibleProducts.length > 0 && visibleProducts.every((p) => selectedIds.has(p.id))
                  ? 'Deselect all'
                  : `Select all (${visibleProducts.length})`}
              </button>
            </div>
            <div className="adm-bulk-bar__actions">
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => { setBulkFieldEditType('description'); setBulkFieldEditValue(''); setBulkFieldEditOpen(true); }} disabled={!!saving}>
                Edit description
              </button>
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => { setBulkFieldEditType('code'); setBulkFieldEditValue(''); setBulkFieldEditOpen(true); }} disabled={!!saving}>
                Edit barcode
              </button>
              <button type="button" className="adm-btn-red adm-btn--sm" onClick={openMoveModal} disabled={!!saving}>
                <ArrowLeftRight size={15} /> Move
              </button>
              <button type="button" className="adm-btn-ghost adm-btn--sm adm-btn-ghost--danger" onClick={() => setArchiveConfirmOpen(true)} disabled={!!saving}>
                <Archive size={15} /> Archive
              </button>
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={moveSelectedToTop} disabled={!!saving}>To top</button>
              <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          </div>
        )}

        <div className="adm-reorder-layout adm-panel-with-sidebar">
          <aside className="adm-panel-sidebar adm-reorder-tree-sidebar">
            <div className="adm-reorder-cat-heading">
              <span>Categories</span>
              <button
                type="button"
                className="adm-taxonomy-add-btn"
                title="Add subcategory"
                onClick={() => onAddSubcategory?.(mainId)}
              >
                <Plus size={16} strokeWidth={2.5} />
              </button>
            </div>
            <p className="adm-section-note" style={{ margin: '0 0 10px', fontSize: 12 }}>
              Drag categories and subcategories by the grip handle. Order saves to the live trade portal automatically.
            </p>
            <CategorySidebar
              tree={taxonomyTree}
              selectedPath={categoryPath}
              onSelectPath={(path) => { setCategoryPath(path); setSelectedIds(new Set()); setSearch(''); }}
              onAddChild={onAddSubcategory}
              onReorder={onCategoryReorder}
              productCounts={categoryProductCounts}
            />
          </aside>

          <ReorderGrid
            products={visibleProducts}
            onProductsChange={handleProductsChange}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            mainCategoryId={mainId}
            selectedPath={categoryPath}
            taxonomyTree={taxonomyTree}
            loading={loading}
            dragDisabled={searchActive || browseAll}
            savingOrder={savingOrder}
            emptyHint={browseAll ? 'Select a category in the sidebar to load products for reordering.' : undefined}
            onEditProduct={onEditProduct}
            onEditSubcategory={onEditSubcategory}
            onDeleteSubcategory={onDeleteSubcategory}
            onOrderCommitted={(next, meta) => scheduleReorderSave(next, meta)}
          />
        </div>

        {moveModalOpen && (
          <div className="adm-modal-backdrop" onClick={() => setMoveModalOpen(false)}>
            <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
              <div className="adm-modal-header">
                <h3 className="adm-modal-title">Move {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'}</h3>
                <button type="button" className="adm-modal-close" onClick={() => setMoveModalOpen(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <p className="adm-modal-note">Choose the destination category for these products.</p>
              <p className="adm-modal-note" style={{ fontWeight: 700, color: '#334155' }}>
                Destination: {movePreviewLabel}
              </p>
              <div className="adm-modal-body">
                <label className="adm-field">
                  <span className="adm-field-label">Main category</span>
                  <select
                    value={moveCategoryId}
                    onChange={(e) => { setMoveCategoryId(e.target.value); setMoveChildIds([]); }}
                    className="adm-select adm-select--enhanced"
                  >
                    {mainCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </label>
                {moveChildFields.map(({ level, options, currentValue }) => (
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
                  onClick={() => { setMoveModalOpen(false); onAddSubcategory?.(deepestId || moveCategoryId); }}
                >
                  <Plus size={15} strokeWidth={2.5} /> New subcategory
                </button>
                <div className="adm-modal-footer__actions">
                  <button type="button" className="adm-btn-ghost" onClick={() => setMoveModalOpen(false)}>Cancel</button>
                  <button type="button" className="adm-btn-red" onClick={() => void confirmBulkMove()} disabled={saving === 'bulk-move'}>
                    {saving === 'bulk-move' ? 'Moving…' : 'Confirm move'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {archiveConfirmOpen && (
          <div className="adm-modal-backdrop" onClick={() => setArchiveConfirmOpen(false)}>
            <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
              <div className="adm-modal-header">
                <h3 className="adm-modal-title">Archive {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'}?</h3>
                <button type="button" className="adm-modal-close" onClick={() => setArchiveConfirmOpen(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <p className="adm-modal-note">Products leave the active grid but are not deleted. Restore them anytime from Archive.</p>
              <div className="adm-modal-footer adm-modal-footer--end">
                <div className="adm-modal-footer__actions">
                  <button type="button" className="adm-btn-ghost" onClick={() => setArchiveConfirmOpen(false)}>Cancel</button>
                  <button type="button" className="adm-btn-red" onClick={() => void confirmBulkArchive()} disabled={saving === 'bulk-archive'}>
                    {saving === 'bulk-archive' ? 'Archiving…' : 'Archive'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {bulkFieldEditOpen && (
          <div className="adm-modal-backdrop" onClick={() => setBulkFieldEditOpen(false)}>
            <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
              <div className="adm-modal-header">
                <h3 className="adm-modal-title">
                  Edit {bulkFieldEditType === 'description' ? 'description' : 'barcode'} for {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'}
                </h3>
                <button type="button" className="adm-modal-close" onClick={() => setBulkFieldEditOpen(false)} aria-label="Close"><X size={18} /></button>
              </div>
              <p className="adm-modal-note">This value will overwrite the existing {bulkFieldEditType === 'description' ? 'description' : 'barcode'} on every selected product.</p>
              <div className="adm-modal-body">
                <label className="adm-field">
                  <span className="adm-field-label">{bulkFieldEditType === 'description' ? 'Description' : 'Barcode'}</span>
                  {bulkFieldEditType === 'description' ? (
                    <textarea
                      value={bulkFieldEditValue}
                      onChange={(e) => setBulkFieldEditValue(e.target.value)}
                      className="adm-field-input"
                      rows={4}
                      style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                      autoFocus
                      placeholder="New description for all selected products…"
                    />
                  ) : (
                    <input
                      value={bulkFieldEditValue}
                      onChange={(e) => setBulkFieldEditValue(e.target.value)}
                      className="adm-field-input"
                      autoFocus
                      placeholder="New barcode / code for all selected products…"
                    />
                  )}
                </label>
              </div>
              <div className="adm-modal-footer adm-modal-footer--end">
                <div className="adm-modal-footer__actions">
                  <button type="button" className="adm-btn-ghost" onClick={() => setBulkFieldEditOpen(false)}>Cancel</button>
                  <button type="button" className="adm-btn-red" onClick={() => void confirmBulkFieldEdit()} disabled={saving === 'bulk-field-edit'}>
                    {saving === 'bulk-field-edit' ? 'Saving…' : 'Apply to all'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </SectionErrorBoundary>
  );
});

export default ReorderPanel;
