import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  Check,
  Grip,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import SectionErrorBoundary from './SectionErrorBoundary';
import { buildCatalogParams, fetchAllCatalogRows, useCatalogQuery } from '../hooks/useCatalog';
import { queryKeys } from '../lib/queryKeys';
import {
  FEATURED_HARD_CAP,
  FEATURED_SOFT_CAP,
  fetchFeaturedProducts,
  saveFeaturedProducts,
} from '../lib/featuredProducts';
import { formatSortSavedAt } from '../lib/sortOrderStore';
import { formatWebsitePrice } from '../lib/pricing';
import { isReadOnlyPreviewHost } from '../lib/previewWriteGuard';

const FEATURED_DRAFT_QUERY_KEY = ['featured-products', 'unsaved-draft'];

export function dispatchFeaturedSave({ previewSimulation = false, items = [], onPreview, onLive } = {}) {
  if (previewSimulation) {
    onPreview?.(items);
    return 'preview';
  }
  onLive?.(items);
  return 'live';
}

export function hasFeaturedChanges(savedItems = [], draftItems = []) {
  return savedItems.map((item) => item.sku).join('\n') !== draftItems.map((item) => item.sku).join('\n');
}

export function canEditFeaturedList({ isSuccess = false, updatedAt = null } = {}) {
  return isSuccess && Boolean(updatedAt);
}

const LINK_BTN = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  textDecoration: 'underline',
  cursor: 'pointer',
};

function catalogRowToProduct(row) {
  const images = row.images || [];
  return {
    id: row.sku,
    sku: row.sku,
    code: row.barcode || row.sku,
    name: row.title || row.name || row.sku,
    image: images[0] || row.image || '',
    stockOnHand: row.stockOnHand ?? row.stockQty ?? 0,
    price: row.price ?? 0,
    stockLinked: row.stockLinked !== false,
    missing: false,
  };
}

function StockStatusBadge({ product }) {
  const soh = product.stockOnHand ?? 0;
  if (soh !== 0 || (product.price ?? 0) !== 0 || product.stockLinked !== false) {
    if (soh === 0 && product.stockLinked === true) {
      return (
        <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', background: '#f1f5f9', borderRadius: 4, padding: '1px 6px' }}>
          Out of stock
        </span>
      );
    }
    if (soh > 0) {
      return (
        <span style={{ fontSize: 10, fontWeight: 700, color: '#166534', background: '#dcfce7', borderRadius: 4, padding: '1px 6px' }}>
          {soh} in stock
        </span>
      );
    }
    return null;
  }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '1px 6px' }}>
      Needs SOH/price
    </span>
  );
}

export function reorderFlatList(list, dragId, overId) {
  if (!dragId || !overId || dragId === overId) return list;
  const from = list.findIndex((p) => p.id === dragId);
  const to = list.findIndex((p) => p.id === overId);
  if (from < 0 || to < 0) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function moveFlatListItem(list, productId, delta) {
  const from = list.findIndex((product) => product.id === productId);
  if (from < 0) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function moveFlatListItemToTop(list, productId) {
  const from = list.findIndex((product) => product.id === productId);
  if (from <= 0) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.unshift(item);
  return next;
}

export function filterFeaturedProducts(products = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return products;
  return products.filter((product) => [product.name, product.sku, product.code]
    .some((value) => String(value || '').toLowerCase().includes(needle)));
}

export function addFeaturedItemToTop(items = [], sku, addedAt = new Date().toISOString()) {
  const normalized = String(sku || '').trim().toUpperCase();
  if (!normalized || items.some((item) => item.sku === normalized)) return items;
  return [{ sku: normalized, addedAt }, ...items];
}

function FeaturedOrderList({ products, searchQuery = '', onReorder, onRemove, saving }) {
  const productsRef = useRef(products);
  productsRef.current = products;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const dragIdRef = useRef(null);
  const overIdRef = useRef(null);
  const onPointerMoveRef = useRef(null);
  const endDragRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const filtering = Boolean(searchQuery.trim());
  const displayedProducts = useMemo(
    () => filterFeaturedProducts(products, searchQuery),
    [products, searchQuery],
  );

  const clearDrag = useCallback(() => {
    dragIdRef.current = null;
    overIdRef.current = null;
    setDragId(null);
    setOverId(null);
    document.body.classList.remove('adm-is-reorder-dragging');
  }, []);

  useEffect(() => {
    const onPointerMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest('[data-featured-id]');
      const nextOver = row?.dataset.featuredId || null;
      if (nextOver && nextOver !== dragIdRef.current) {
        overIdRef.current = nextOver;
        setOverId(nextOver);
      }
    };
    const endDrag = (event) => {
      const hadDrag = !!dragIdRef.current;
      const dropTarget = overIdRef.current;
      if (event?.type !== 'pointercancel' && hadDrag && dropTarget && dragIdRef.current !== dropTarget) {
        onReorderRef.current(reorderFlatList(productsRef.current, dragIdRef.current, dropTarget));
      }
      clearDrag();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
    const cancelWithKeyboard = (event) => {
      if (event.key !== 'Escape' || !dragIdRef.current) return;
      endDrag({ type: 'pointercancel' });
    };
    onPointerMoveRef.current = onPointerMove;
    endDragRef.current = endDrag;
    window.addEventListener('keydown', cancelWithKeyboard);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('keydown', cancelWithKeyboard);
      document.body.classList.remove('adm-is-reorder-dragging');
      onPointerMoveRef.current = null;
      endDragRef.current = null;
    };
  }, [clearDrag]);

  const startDrag = useCallback((productId, e) => {
    if (saving) return;
    e.preventDefault();
    dragIdRef.current = productId;
    setDragId(productId);
    document.body.classList.add('adm-is-reorder-dragging');
    const move = onPointerMoveRef.current;
    const end = endDragRef.current;
    if (move) window.addEventListener('pointermove', move);
    if (end) window.addEventListener('pointerup', end);
    if (end) window.addEventListener('pointercancel', end);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [saving]);

  const moveBy = useCallback((productId, delta) => {
    if (saving) return;
    onReorder(moveFlatListItem(products, productId, delta));
  }, [onReorder, products, saving]);

  const moveToTop = useCallback((productId) => {
    if (saving) return;
    onReorder(moveFlatListItemToTop(products, productId));
  }, [onReorder, products, saving]);

  const handleGripKeyDown = useCallback((productId, event) => {
    const columnCount = Number.parseInt(
      getComputedStyle(event.currentTarget.closest('.featured-order-grid'))
        .getPropertyValue('--featured-grid-columns'),
      10,
    ) || 1;
    const delta = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columnCount,
      ArrowDown: columnCount,
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    moveBy(productId, delta);
  }, [moveBy]);

  if (!products.length) {
    return (
      <p className="adm-section-note" style={{ margin: '24px 0' }}>
        No featured products yet. Search below and add the first product for the home page.
      </p>
    );
  }

  if (!displayedProducts.length) {
    return (
      <p className="adm-section-note featured-current-empty">
        No featured products match this search.
      </p>
    );
  }

  return (
    <div className="featured-order-grid" role="list" aria-label="Featured products in storefront order">
      {displayedProducts.map((product) => {
        const index = products.findIndex((item) => item.id === product.id);
        return (
        <div
          key={product.id}
          data-featured-id={product.id}
          role="listitem"
          aria-label={`${index + 1}. ${product.name}`}
          className={`featured-order-row${dragId === product.id ? ' featured-order-row--dragging' : ''}${overId === product.id && dragId !== product.id ? ' featured-order-row--over' : ''}`}
        >
          <span className="featured-order-position" aria-hidden="true">{index + 1}</span>
          <button
            type="button"
            className="featured-order-grip"
            aria-label={filtering
              ? `Clear the featured search to drag ${product.name}`
              : `Move ${product.name}. Position ${index + 1} of ${products.length}. Use arrow keys or drag.`}
            onPointerDown={(e) => startDrag(product.id, e)}
            onKeyDown={(e) => handleGripKeyDown(product.id, e)}
            disabled={saving || filtering}
            title={filtering ? 'Clear search to drag' : 'Drag to reorder'}
          >
            <Grip size={14} />
          </button>
          <div className="adm-product-thumb featured-order-thumb">
            {product.image
              ? <img src={product.image} alt="" loading="lazy" decoding="async" />
              : <span className="adm-muted">IMG</span>}
          </div>
          <div className="featured-order-meta">
            <strong>{product.name}</strong>
            <div className="adm-muted" style={{ fontSize: 11 }}>
              {product.code}
              {product.missing && <span style={{ color: '#b45309', marginLeft: 8 }}>Not in live catalogue</span>}
            </div>
            <StockStatusBadge product={product} />
          </div>
          <div className="featured-order-actions">
            <button
              type="button"
              className="featured-order-top"
              aria-label={`Move ${product.name} to the top of featured products`}
              title="Move to top"
              onClick={() => moveToTop(product.id)}
              disabled={saving || index === 0}
            >
              <ArrowUpToLine size={13} />
              Move to top
            </button>
            <button
              type="button"
              className="featured-order-nudge"
              aria-label={`Move ${product.name} one position earlier`}
              title="Move earlier"
              onClick={() => moveBy(product.id, -1)}
              disabled={saving || filtering || index === 0}
            >
              <ArrowLeft size={13} />
            </button>
            <button
              type="button"
              className="featured-order-nudge"
              aria-label={`Move ${product.name} one position later`}
              title="Move later"
              onClick={() => moveBy(product.id, 1)}
              disabled={saving || filtering || index === products.length - 1}
            >
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              className="featured-order-remove"
              title="Remove from featured"
              aria-label={`Remove ${product.name} from featured products`}
              onClick={() => onRemove(product.sku)}
              disabled={saving}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function FeaturedPanelInner({ taxonomyTree = [], onShowToast }) {
  const queryClient = useQueryClient();
  const previewSimulation = typeof window !== 'undefined'
    && isReadOnlyPreviewHost(window.location.hostname);
  const [searchInput, setSearchInput] = useState('');
  const [featuredSearch, setFeaturedSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [saveMeta, setSaveMeta] = useState({ updatedAt: null });
  const latestUpdatedAtRef = useRef(null);
  const [saveState, setSaveState] = useState(previewSimulation ? 'preview' : 'saved');
  const pickSaveTimerRef = useRef(null);
  const orderSaveTimerRef = useRef(null);
  const pendingItemsRef = useRef(null);
  const pendingBaseItemsRef = useRef(null);
  const [draft, setDraft] = useState(() => queryClient.getQueryData(FEATURED_DRAFT_QUERY_KEY) || null);

  // The app-wide defaults are staleTime 60s, no focus refetch and no interval,
  // which suit the heavy catalogue queries. They are wrong for this one: when
  // another admin edits the featured list there is nothing to tell this tab,
  // so it keeps showing its own cached copy indefinitely. The payload is a
  // short list of SKUs, so refetching it freely costs nothing.
  const featuredQuery = useQuery({
    queryKey: queryKeys.featuredProducts(),
    queryFn: fetchFeaturedProducts,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: draft === null && (saveState === 'saved' || saveState === 'error'),
  });

  const savedFeaturedItems = featuredQuery.data?.items || [];
  const featuredItems = draft?.items ?? savedFeaturedItems;
  const hasUnsavedChanges = hasFeaturedChanges(savedFeaturedItems, featuredItems);
  // The production list always has an updatedAt token. A successful-looking
  // response without one can be the storage layer's empty fallback, so never
  // let that state become the basis for replacing the real list.
  const featuredListReady = canEditFeaturedList({
    isSuccess: featuredQuery.isSuccess,
    updatedAt: featuredQuery.data?.updatedAt,
  });
  const featuredSkuSet = useMemo(
    () => new Set(featuredItems.map((item) => item.sku)),
    [featuredItems],
  );

  useEffect(() => {
    if (featuredQuery.data?.updatedAt) {
      latestUpdatedAtRef.current = featuredQuery.data.updatedAt;
      setSaveMeta((prev) => ({ ...prev, updatedAt: featuredQuery.data.updatedAt }));
    }
  }, [featuredQuery.data?.updatedAt]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryId]);

  const categoryPath = useMemo(
    () => (categoryId ? [categoryId] : []),
    [categoryId],
  );

  const catalogParams = useMemo(() => buildCatalogParams({
    status: 'live',
    page,
    pageSize: 50,
    search: debouncedSearch,
    categoryPath,
    onlyInStock: false,
  }), [page, debouncedSearch, categoryPath]);

  const pickerQuery = useCatalogQuery(catalogParams, { enabled: true });
  const pickerRows = pickerQuery.data?.rows || [];
  const pickerTotal = pickerQuery.data?.total || 0;

  const hydrateQuery = useQuery({
    queryKey: ['catalog', 'featured-hydrate'],
    queryFn: () => fetchAllCatalogRows({ status: 'live', onlyInStock: false }),
    staleTime: 60_000,
    enabled: featuredItems.length > 0,
  });

  const catalogBySku = useMemo(() => {
    const map = new Map();
    for (const row of hydrateQuery.data || []) {
      map.set(row.sku, catalogRowToProduct(row));
    }
    return map;
  }, [hydrateQuery.data]);

  const orderedFeaturedProducts = useMemo(() => featuredItems.map((item) => {
    const live = catalogBySku.get(item.sku);
    if (live) return live;
    return {
      id: item.sku,
      sku: item.sku,
      code: item.sku,
      name: item.sku,
      image: '',
      stockOnHand: 0,
      price: 0,
      stockLinked: false,
      missing: true,
    };
  }), [featuredItems, catalogBySku]);

  // Every save gets a number so an older response can never repaint newer work.
  const editSeqRef = useRef(0);

  const saveMutation = useMutation({
    mutationFn: ({ items, seq, baseUpdatedAt, baseItems }) => saveFeaturedProducts(
      items,
      baseUpdatedAt,
      baseItems,
    ).then((data) => ({ ...data, seq })),
    onSuccess: (data) => {
      // A response from a superseded edit must not repaint the list.
      if (data.seq !== editSeqRef.current) return;
      latestUpdatedAtRef.current = data.updatedAt;
      queryClient.setQueryData(queryKeys.featuredProducts(), { items: data.items, updatedAt: data.updatedAt });
      queryClient.removeQueries({ queryKey: FEATURED_DRAFT_QUERY_KEY, exact: true });
      setDraft(null);
      setSaveMeta({ updatedAt: data.updatedAt });
      setSaveState('saved');
    },
    onError: (err) => {
      setSaveState('error');
      onShowToast?.(err.message || 'Failed to save featured list', 'error');
    },
  });

  /** Drop any debounced save that has not fired yet — it is now out of date. */
  const cancelQueuedSaves = useCallback(() => {
    if (pickSaveTimerRef.current) clearTimeout(pickSaveTimerRef.current);
    if (orderSaveTimerRef.current) clearTimeout(orderSaveTimerRef.current);
    pickSaveTimerRef.current = null;
    orderSaveTimerRef.current = null;
    pendingItemsRef.current = null;
    pendingBaseItemsRef.current = null;
  }, []);

  const updateDraftItems = useCallback((items) => {
    if (!hasFeaturedChanges(savedFeaturedItems, items)) {
      queryClient.removeQueries({ queryKey: FEATURED_DRAFT_QUERY_KEY, exact: true });
      setDraft(null);
      setSaveState(previewSimulation ? 'preview' : 'saved');
      return;
    }
    const next = {
      items,
      baseUpdatedAt: draft?.baseUpdatedAt || featuredQuery.data?.updatedAt || null,
    };
    queryClient.setQueryData(FEATURED_DRAFT_QUERY_KEY, next);
    setDraft(next);
    setSaveState(previewSimulation ? 'preview' : 'saved');
  }, [draft?.baseUpdatedAt, featuredQuery.data?.updatedAt, previewSimulation, queryClient, savedFeaturedItems]);

  const clearDraft = useCallback(() => {
    cancelQueuedSaves();
    queryClient.removeQueries({ queryKey: FEATURED_DRAFT_QUERY_KEY, exact: true });
    setDraft(null);
    setSaveState(previewSimulation ? 'preview' : 'saved');
  }, [cancelQueuedSaves, previewSimulation, queryClient]);

  const saveDraft = useCallback(() => {
    if (!hasUnsavedChanges || !featuredListReady) return;
    cancelQueuedSaves();
    dispatchFeaturedSave({
      previewSimulation,
      items: featuredItems,
      onPreview: () => {
        setSaveState('preview');
        onShowToast?.('Preview only — no website or backend changes were saved.', 'success');
      },
      onLive: () => {
        setSaveState('saving');
        const seq = (editSeqRef.current += 1);
        saveMutation.mutate({
          items: featuredItems,
          seq,
          baseUpdatedAt: draft?.baseUpdatedAt || featuredQuery.data?.updatedAt || null,
          baseItems: savedFeaturedItems,
        });
      },
    });
  }, [cancelQueuedSaves, draft?.baseUpdatedAt, featuredItems, featuredListReady, featuredQuery.data?.updatedAt, hasUnsavedChanges, onShowToast, previewSimulation, saveMutation, savedFeaturedItems]);

  useEffect(() => () => {
    if (pickSaveTimerRef.current) clearTimeout(pickSaveTimerRef.current);
    if (orderSaveTimerRef.current) clearTimeout(orderSaveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  const toggleFeatured = useCallback((sku, checked, placement = 'end') => {
    if (!featuredListReady) return;
    const normalized = String(sku || '').trim().toUpperCase();
    if (!normalized) return;
    if (checked) {
      if (featuredSkuSet.has(normalized)) return;
      if (featuredItems.length >= FEATURED_HARD_CAP) {
        onShowToast?.(`Maximum ${FEATURED_HARD_CAP} featured products`, 'error');
        return;
      }
      const addedAt = new Date().toISOString();
      updateDraftItems(placement === 'top'
        ? addFeaturedItemToTop(featuredItems, normalized, addedAt)
        : [...featuredItems, { sku: normalized, addedAt }]);
      return;
    }
    updateDraftItems(featuredItems.filter((item) => item.sku !== normalized));
  }, [featuredItems, featuredListReady, featuredSkuSet, onShowToast, updateDraftItems]);

  const removeFeatured = useCallback((sku) => {
    if (!featuredListReady) return;
    const normalized = String(sku || '').trim().toUpperCase();
    if (!window.confirm(`Remove ${normalized} from featured products?`)) return;
    updateDraftItems(featuredItems.filter((item) => item.sku !== normalized));
  }, [featuredItems, featuredListReady, updateDraftItems]);

  const handleReorder = useCallback((nextProducts) => {
    const skuOrder = nextProducts.map((p) => p.sku);
    const bySku = new Map(featuredItems.map((item) => [item.sku, item]));
    const nextItems = skuOrder.map((sku) => bySku.get(sku)).filter(Boolean);
    updateDraftItems(nextItems);
  }, [featuredItems, updateDraftItems]);

  const slotsRemaining = Math.max(0, FEATURED_SOFT_CAP - featuredItems.length);
  const overSoftCap = featuredItems.length > FEATURED_SOFT_CAP;
  const saving = saveMutation.isPending;

  useEffect(() => {
    if (saving) setSaveState('saving');
  }, [saving]);

  const mainCategories = useMemo(
    () => (taxonomyTree || []).filter((c) => c.id !== 'mottaro'),
    [taxonomyTree],
  );

  return (
    <div className="adm-panel">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={20} />
            Featured
          </h2>
          <p className="adm-section-note">
            Pick and order products for the trade portal home page (portal display is configured separately).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {previewSimulation ? (
            <span className="adm-pill" role="status" style={{ fontSize: 12, color: '#1d4ed8', borderColor: '#bfdbfe' }}>
              Preview simulation — changes stay on this page
            </span>
          ) : saveState === 'error' ? (
            <span className="adm-pill" role="status" style={{ fontSize: 12, color: '#b91c1c', borderColor: '#fecaca' }}>
              Save failed — your changes are still here
            </span>
          ) : saveState === 'saving' ? (
            <span className="adm-pill" role="status" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={12} className="spin" />
              Saving featured products…
            </span>
          ) : hasUnsavedChanges ? (
            <span className="adm-pill" role="status" style={{ fontSize: 12, color: '#92400e', borderColor: '#fcd34d' }}>
              Changes not saved yet
            </span>
          ) : saveMeta.updatedAt && formatSortSavedAt(saveMeta.updatedAt) && (
            <span className="adm-pill" role="status" style={{ fontSize: 12 }}>
              Live order saved · {formatSortSavedAt(saveMeta.updatedAt)}
            </span>
          )}
        </div>
      </div>

      <div className="adm-toolbar pm-toolbar featured-workspace-toolbar" style={{ marginBottom: 12 }}>
        <span className="adm-pill" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {featuredItems.length} featured · {slotsRemaining} slots remaining (of {FEATURED_SOFT_CAP})
        </span>
        <button
          type="button"
          className="adm-btn-ghost adm-btn--sm"
          onClick={clearDraft}
          disabled={!hasUnsavedChanges || saving || !featuredListReady}
        >
          <RotateCcw size={14} /> Undo changes
        </button>
        <button
          type="button"
          className="adm-btn-green adm-btn--sm"
          onClick={saveDraft}
          disabled={!hasUnsavedChanges || saving || !featuredListReady}
        >
          {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          {previewSimulation ? 'Test save safely' : 'Save changes'}
        </button>
      </div>

      {overSoftCap && (
        <p className="adm-section-note" style={{ color: '#b45309', marginBottom: 12 }}>
          {FEATURED_SOFT_CAP} recommended for the home page — currently {featuredItems.length}.
        </p>
      )}

      {featuredQuery.isSuccess && !featuredListReady && (
        <div className="featured-load-warning" role="alert">
          <strong>The existing Featured list could not be verified.</strong>
          <span>Editing is disabled so the current website list cannot be overwritten.</span>
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => featuredQuery.refetch()}>
            Try loading again
          </button>
        </div>
      )}

      <section className="featured-workspace-section" aria-labelledby="featured-current-heading">
          <h3 id="featured-current-heading" className="featured-workspace-heading">1. Current featured products</h3>
          <div className="featured-order-guide" role="note">
            <ArrowUpToLine size={15} />
            <span>
              {previewSimulation
                ? 'Find a product, then use Move to top. Preview changes are temporary and never saved.'
                : 'Find a product, then use Move to top. Arrow controls and dragging remain available when the search is clear.'}
            </span>
          </div>
          <div className="featured-current-toolbar">
            <label className="adm-search featured-current-search">
              <Search size={15} />
              <input
                type="search"
                className="adm-search-input"
                placeholder="Find a featured product…"
                value={featuredSearch}
                onChange={(event) => setFeaturedSearch(event.target.value)}
              />
            </label>
            {featuredSearch.trim() && (
              <>
                <span className="adm-muted featured-current-count" role="status">
                  {filterFeaturedProducts(orderedFeaturedProducts, featuredSearch).length} found
                </span>
                <button
                  type="button"
                  className="adm-btn-ghost adm-btn--sm"
                  onClick={() => setFeaturedSearch('')}
                >
                  <X size={14} /> Clear search
                </button>
              </>
            )}
          </div>
          {featuredSearch.trim() && (
            <p className="adm-section-note featured-filter-note">
              Move to top stays available. Clear the search to drag or move one place at a time.
            </p>
          )}
          {featuredQuery.isLoading ? (
            <p className="adm-section-note"><Loader2 size={14} className="spin" /> Loading featured products…</p>
          ) : featuredQuery.isError ? (
            <p className="adm-section-note" style={{ color: '#b91c1c' }}>
              Could not load the featured list: {featuredQuery.error?.message || 'request failed'}.{' '}
              <button type="button" style={LINK_BTN} onClick={() => featuredQuery.refetch()}>Try again</button>
            </p>
          ) : (
            <>
              {/* Names, images and stock come from a full-catalogue fetch. The
                  list itself does not depend on it, so render the rows (and
                  their Remove buttons) immediately and let the detail fill in
                  — waiting used to leave the whole section on a spinner, or
                  showing bare SKUs if that fetch failed, which read as
                  "featured products don't load". */}
              {featuredItems.length > 0 && hydrateQuery.isLoading && (
                <p className="adm-section-note"><Loader2 size={14} className="spin" /> Loading product details…</p>
              )}
              {featuredItems.length > 0 && hydrateQuery.isError && (
                <p className="adm-section-note" style={{ color: '#b45309' }}>
                  Showing codes only — product details failed to load.{' '}
                  <button type="button" style={LINK_BTN} onClick={() => hydrateQuery.refetch()}>Retry</button>
                </p>
              )}
              <FeaturedOrderList
                products={orderedFeaturedProducts}
                searchQuery={featuredSearch}
                onReorder={handleReorder}
                onRemove={removeFeatured}
                saving={saving || !featuredListReady}
              />
            </>
          )}
      </section>

      <section className="featured-workspace-section" aria-labelledby="featured-add-heading">
          <div className="featured-workspace-section-head">
            <div>
              <h3 id="featured-add-heading" className="featured-workspace-heading">2. Add more products</h3>
              <p className="adm-section-note">Search the catalogue and choose Add to top. The product appears first immediately.</p>
            </div>
          </div>
          <div className="adm-toolbar pm-toolbar" style={{ marginBottom: 12 }}>
            <label className="adm-search" style={{ flex: 1, minWidth: 200 }}>
              <Search size={15} />
              <input
                type="search"
                className="adm-search-input"
                placeholder="Search SKU, barcode, title…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </label>
            <select
              className="adm-select adm-select--enhanced"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              style={{ minWidth: 180 }}
            >
              <option value="">All categories</option>
              {mainCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>

          {pickerQuery.isLoading && !pickerQuery.data ? (
            <p className="adm-section-note"><Loader2 size={14} className="spin" /> Loading products…</p>
          ) : (
            <>
              <div className="featured-pick-grid">
                {pickerRows.map((row) => {
                  const product = catalogRowToProduct(row);
                  const checked = featuredSkuSet.has(product.sku);
                  return (
                    <article
                      key={product.sku}
                      className={`featured-pick-card${checked ? ' featured-pick-card--selected' : ''}`}
                    >
                      <div className="adm-product-thumb featured-pick-thumb">
                        {product.image
                          ? <img src={product.image} alt="" loading="lazy" decoding="async" />
                          : <span className="adm-muted">IMG</span>}
                      </div>
                      <div className="featured-pick-meta">
                        <strong>{product.name}</strong>
                        <div className="adm-muted" style={{ fontSize: 11 }}>{product.code}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          <StockStatusBadge product={product} />
                          {product.price > 0 && (
                            <span className="adm-muted" style={{ fontSize: 11 }}>R{formatWebsitePrice(product.price)}</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`featured-pick-action${checked ? ' featured-pick-action--selected' : ''}`}
                        disabled={saving || !featuredListReady}
                        onClick={() => toggleFeatured(product.sku, !checked, checked ? 'end' : 'top')}
                        aria-label={`${checked ? 'Remove' : 'Add'} ${product.name} ${checked ? 'from' : 'to'} featured products`}
                      >
                        {checked ? <><Check size={13} /> Featured</> : <><ArrowUpToLine size={13} /> Add to top</>}
                      </button>
                    </article>
                  );
                })}
              </div>
              {pickerRows.length === 0 && (
                <p className="adm-section-note">No products match your search.</p>
              )}
              {pickerTotal > 50 && (
                <div className="adm-toolbar" style={{ marginTop: 12, justifyContent: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="adm-btn-ghost adm-btn--sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <span className="adm-muted" style={{ fontSize: 12 }}>
                    Page {page} of {Math.max(1, Math.ceil(pickerTotal / 50))}
                  </span>
                  <button
                    type="button"
                    className="adm-btn-ghost adm-btn--sm"
                    disabled={page >= Math.ceil(pickerTotal / 50)}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
      </section>
    </div>
  );
}

export default function FeaturedPanel(props) {
  return (
    <SectionErrorBoundary name="featured" title="Featured tab crashed">
      <FeaturedPanelInner {...props} />
    </SectionErrorBoundary>
  );
}
