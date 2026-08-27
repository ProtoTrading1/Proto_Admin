import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  ChevronLeft,
  FileSpreadsheet,
  FolderMinus,
  FolderPlus,
  FolderTree,
  Grip,
  Layers,
  Loader2,
  PackageCheck,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import CategorySidebar, { resolvePathLabels } from './CategorySidebar';
import ActionMenu from './ActionMenu';
import FilterMenu from './FilterMenu';
import BulkProductEditModal from './BulkProductEditModal';
import BulkMoveModal from './BulkMoveModal';
import MergeIntoGroupModal from './MergeIntoGroupModal';
import { useCatalogQuery, buildCatalogParams, fetchAllCatalogRows, CATALOG_STATUSES } from '../hooks/useCatalog';
import { useCatalogMutations } from '../hooks/useCatalogMutations';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { queryClient } from '../lib/queryClient';
import { queryKeys } from '../lib/queryKeys';
import { sortOrderCategoryKey, lookupSortOrder, applySkuOrder, sortOrderLookupKeys } from '../lib/taxonomy';
import { persistSortOrder, fetchSortOrderStore, sortMetaForPath, formatSortSavedAt, fetchSortMetaForCategory } from '../lib/sortOrderStore';
import { exportProductsCatalogXlsx, exportAllProductsCatalogXlsx, exportSelectedProductsXlsx } from '../lib/exportLiveProducts';
import { bulkMoveProducts, bulkRemoveFromCategory, invalidateAdminCache, updateProduct, previewFloaters, archiveFloaters } from '../lib/products';
import { partitionPlacedOnly } from '../lib/placements';
import { formatWebsitePrice } from '../lib/pricing';
import { childrenOfTree, fetchCategoryProductCounts, subcategoryOptionsFromTree, listHiddenMottaro, restoreMottaroNode } from '../lib/taxonomyAdmin';
import { sellingUnitLabel } from '../../lib/selling-unit.mjs';
import { ARCHIVE_PRIORITY_STORAGE_KEY, readArchivePrioritySkus } from '../../lib/archive-priority.mjs';

const ONLY_IN_STOCK_KEY = 'pm_only_in_stock';
const CATALOG_MUTATED_STORAGE_KEY = 'proto-catalog-mutated-at';

function readOnlyInStockPref() {
  try {
    return sessionStorage.getItem(ONLY_IN_STOCK_KEY) === '1';
  } catch {
    return false;
  }
}

const STATUS_META = {
  live: { label: 'Live', icon: PackagePlus },
  archived: { label: 'Archived', icon: Archive },
  recycle: { label: 'Recycle Bin', icon: Trash2 },
};

const ROW_COLUMNS = {
  live: '32px 96px 2fr 140px 140px',
  archived: '32px 96px 2fr 140px 140px',
  recycle: '32px 96px 2fr 140px',
};

const STOCK_STATUSES = new Set(['live', 'archived']);

const LARGE_BULK_MOVE_THRESHOLD = 100;

/**
 * Toast text for a restore that succeeded but where a storefront sync RPC
 * failed (server returns the failures in `syncWarnings`) — the product is
 * unarchived yet may be missing from the site until the next sync runs.
 */
function syncWarningMessage(syncWarnings, { plural = false } = {}) {
  const detail = (syncWarnings || []).join('; ');
  return plural
    ? `Products restored, but storefront sync failed: ${detail}. They may not appear on the site until the next sync.`
    : `Product restored, but storefront sync failed: ${detail}. It may not appear on the site until the next sync.`;
}

function MultiCategoryBadge({ item, tree }) {
  const placements = item?.placementPaths || [];
  if (!item?.isMultiCategory && !placements.length) return null;
  const primary = [item.categoryLabel, ...(item.subcategoryLabels || [])].filter(Boolean).join(' › ');
  const alsoIn = [
    item.isMultiCategory
      ? (item.alternateCategoryPath?.length ? resolvePathLabels(tree, item.alternateCategoryPath).join(' › ') : 'Motarro')
      : null,
    ...placements.map((path) => resolvePathLabels(tree, path).join(' › ') || path.join(' › ')),
  ].filter(Boolean);
  // Count every place a customer can find it: primary + Mottaro + placements.
  const total = (primary ? 1 : 0) + alsoIn.length;
  // Blue when the product was deliberately placed by an admin, purple for a
  // Mottaro-only product, so the two reasons are distinguishable at a glance.
  const placed = placements.length > 0;
  return (
    <span
      title={`Primary: ${primary || 'Uncategorised'}\nAlso in:\n  ${alsoIn.join('\n  ')}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: placed ? '#075985' : '#5b21b6',
        background: placed ? '#e0f2fe' : '#ede9fe',
        border: `1px solid ${placed ? '#7dd3fc' : '#ddd6fe'}`,
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      In {total} categories
    </span>
  );
}

function ProductCategoryLine({ item, tree }) {
  const placements = item.placementPaths || [];
  if (!item.categoryLabel && !item.isMultiCategory && !placements.length) return null;
  const primary = [item.categoryLabel, ...(item.subcategoryLabels || [])].filter(Boolean).join(' › ');
  return (
    <div className="adm-muted" style={{ fontSize: 11 }}>
      {primary}
      {item.isMultiCategory && item.alternateCategoryPath?.length > 1 && (
        <span style={{ display: 'block', color: '#6d28d9', marginTop: 2 }}>
          + Motarro › {item.alternateCategoryPath.slice(1).map((id) => id.replace(/^mottaro-/, '').replace(/-/g, ' ')).join(' › ')}
        </span>
      )}
      {placements.map((path) => (
        <span key={path.join('/')} style={{ display: 'block', color: '#0369a1', marginTop: 2 }}>
          + {resolvePathLabels(tree, path).join(' › ') || path.join(' › ')}
        </span>
      ))}
    </div>
  );
}

function formatStockUnits(qty) {
  const n = qty === null || qty === undefined ? 0 : Number(qty);
  return `${Number.isFinite(n) ? n : 0} units`;
}

const MOVED_TAG_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Colored tag shown for 48h after a product is moved, e.g. "Beads → Hardware". */
function MovedBadge({ item }) {
  if (!item?.movedAt || !item?.movedTo) return null;
  const movedAt = new Date(item.movedAt).getTime();
  if (!Number.isFinite(movedAt) || Date.now() - movedAt > MOVED_TAG_WINDOW_MS) return null;
  const from = item.movedFrom || 'Uncategorised';
  return (
    <span
      title={`Moved ${new Date(item.movedAt).toLocaleString('en-ZA')} — from ${from} to ${item.movedTo}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#9a3412',
        background: '#ffedd5',
        border: '1px solid #fdba74',
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
        maxWidth: 260,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {from} → {item.movedTo}
    </span>
  );
}

const ARCHIVE_TAGS = {
  'excel-images': { label: 'Excel import', title: 'Staged from an Excel file and local image folder', color: '#1d4ed8', background: '#dbeafe' },
  nutstore: { label: 'Nutstore', title: 'Archived from Nutstore Product Loader', color: '#5b21b6', background: '#ede9fe' },
  floater: { label: 'Floater', title: 'Archived by the floater sweep — had no category (or an unknown category)', color: '#9a3412', background: '#ffedd5' },
  'category-deleted': { label: 'Category deleted', title: 'Archived because its category was deleted', color: '#9a3412', background: '#ffedd5' },
  'mottaro-deleted': { label: 'Motarro deleted', title: 'Archived because its Motarro subcategory was deleted', color: '#9a3412', background: '#ffedd5' },
};

function NutstoreArchiveBadge({ archivedBy }) {
  const source = String(archivedBy || '');
  const tag = ARCHIVE_TAGS[source]
    || (source.startsWith('excel-images:') ? ARCHIVE_TAGS['excel-images'] : null);
  if (!tag) return null;
  return (
    <span
      title={tag.title}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: tag.color,
        background: tag.background,
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {tag.label}
    </span>
  );
}

function NeedsSohPriceBadge({ item }) {
  const soh = item.stockOnHand ?? item.stockQty ?? 0;
  if (soh !== 0 || (item.price ?? 0) !== 0 || item.stockLinked !== false) return null;
  return (
    <span
      title="No Positill match yet — set price and stock on hand"
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#92400e',
        background: '#fef3c7',
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      Needs SOH/price
    </span>
  );
}

/** ERP-linked but Positill reports 0 SOH — waiting for stock, not missing data. */
function OutOfStockLinkedBadge({ item }) {
  const soh = item.stockOnHand ?? item.stockQty ?? 0;
  if (soh !== 0 || item.stockLinked !== true) return null;
  return (
    <span
      title="Linked to Positill — waiting for stock to arrive"
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#475569',
        background: '#f1f5f9',
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      Out of stock
    </span>
  );
}

function CatalogSkeleton() {
  return (
    <div className="pm-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="pm-skeleton-row" />
      ))}
    </div>
  );
}

function PmMobileProductCard({
  item,
  index,
  status,
  selected,
  showStockColumn,
  onCheckboxClick,
  onRowShiftClick,
  onEditProduct,
  onMakeLive,
  mutations,
  onRefreshStats,
  recycleSku,
  onShowToast,
  onToggleToOrder,
  toOrderPendingSku,
  onToggleStockAvailable,
  stockAvailablePendingSku,
  tree,
}) {
  return (
    <article
      className={`pm-mobile-card${selected.has(item.id) ? ' pm-mobile-card--selected' : ''}`}
      onClick={(e) => onRowShiftClick?.(e, item.id, item, index)}
    >
      <div className="pm-mobile-card-top">
        <input
          type="checkbox"
          checked={selected.has(item.id)}
          onClick={(e) => onCheckboxClick(e, item.id, item, index)}
          readOnly
          style={{ accentColor: '#8B1A1A', cursor: 'pointer' }}
          aria-label={`Select ${item.sku}`}
        />
        {item.image ? (
          <img src={item.image} alt="" loading="lazy" decoding="async" className="adm-product-thumb pm-mobile-card-thumb" />
        ) : (
          <div className="adm-product-thumb adm-product-thumb--placeholder pm-mobile-card-thumb">IMG</div>
        )}
        <div className="pm-mobile-card-main">
          <strong>{productListTitle(item, status)}</strong>
          {!item.image && (
            <span className="pm-mobile-card-badge">No image</span>
          )}
          {item.isNew && (
            <span className="pm-mobile-card-badge" style={{ background: '#0f766e', color: '#fff' }}>Special</span>
          )}
          {item.toOrder && (
            <span className="pm-mobile-card-badge" style={{ background: '#b45309', color: '#fff' }}>To order</span>
          )}
          {item.stockAvailable && (
            <span className="pm-mobile-card-badge" style={{ background: '#0369a1', color: '#fff' }}>Stock available</span>
          )}
          {item.variantGroup?.isPrimary && (
            <span className="pm-mobile-card-badge" style={{ background: '#6d28d9', color: '#fff' }}>
              {item.variantGroup.variantCount ? `${item.variantGroup.variantCount} variants` : 'Group'}
            </span>
          )}
          <NutstoreArchiveBadge archivedBy={item.archivedBy} />
          <NeedsSohPriceBadge item={item} />
          <OutOfStockLinkedBadge item={item} />
          <MultiCategoryBadge item={item} tree={tree} />
          <MovedBadge item={item} />
          <div className="adm-muted pm-mobile-card-meta">
            <span>BC: <CodeEllipsis value={item.barcode || item.code} /></span>
            {item.sku && <span>WSK: <CodeEllipsis value={item.sku} /></span>}
            {item.price > 0 && <span>R{formatWebsitePrice(item.price)}</span>}
            {item.toOrder && <span>Unit: {sellingUnitLabel(item.unitsOfIssue)}</span>}
            {item.toOrder && <span>Minimum: {Math.max(1, Number(item.minQty) || 1)}</span>}
          </div>
          {item.categoryLabel && (
            <ProductCategoryLine item={item} tree={tree} />
          )}
          {showStockColumn && (
            <div className="pm-mobile-card-stock">
              {formatStockUnits(item.stockQty)}
            </div>
          )}
        </div>
      </div>
      <div className="pm-mobile-card-actions">
        {onEditProduct && (
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => onEditProduct(item)}>
            <Pencil size={14} /> Edit
          </button>
        )}
        {status === 'live' && (
          <>
            <button
              type="button"
              className={`adm-btn-ghost adm-btn--sm${item.toOrder ? ' pm-toorder-btn--on' : ''}`}
              aria-pressed={!!item.toOrder}
              disabled={toOrderPendingSku === item.sku}
              onClick={() => onToggleToOrder?.(item)}
            >
              {toOrderPendingSku === item.sku ? <Loader2 size={14} className="spin" /> : <PackagePlus size={14} />}
              To order
            </button>
            <button
              type="button"
              className={`adm-btn-ghost adm-btn--sm${item.stockAvailable ? ' pm-stockavailable-btn--on' : ''}`}
              aria-pressed={!!item.stockAvailable}
              disabled={stockAvailablePendingSku === item.sku}
              title={item.stockAvailable ? 'Stock available — click to turn off' : "Mark recently arrived stock as available"}
              onClick={() => onToggleStockAvailable?.(item)}
            >
              {stockAvailablePendingSku === item.sku ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />}
              Stock available
            </button>
            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => mutations.archive.mutate(item.sku, { onSuccess: () => onRefreshStats?.(), onError: (err) => onShowToast?.(err.message || 'Archive failed', 'error') })}>Archive</button>
            <button type="button" className="adm-btn-red adm-btn--sm" title="Move to recycle bin" aria-label="Move to recycle bin" onClick={() => recycleSku(item.sku, false)}><Trash2 size={14} /></button>
          </>
        )}
        {status === 'archived' && (
          <>
            <button type="button" className="adm-btn-red adm-btn--sm" onClick={() => onMakeLive?.(item)}>
              <ArchiveRestore size={14} /> Make live
            </button>
            <button type="button" className="adm-btn-ghost adm-btn--sm" title="Move to recycle bin" aria-label="Move to recycle bin" onClick={() => recycleSku(item.sku, true)}><Trash2 size={14} /></button>
          </>
        )}
        {status === 'recycle' && (
          <>
            <button
              type="button"
              className="adm-btn-ghost adm-btn--sm"
              onClick={() => mutations.restoreRecycle.mutate(item.sku, {
                onSuccess: (data) => {
                  onRefreshStats?.();
                  if (data?.syncWarnings?.length) onShowToast?.(syncWarningMessage(data.syncWarnings), 'warning');
                },
              })}
            >
              <ArchiveRestore size={14} /> Restore
            </button>
            <button type="button" className="adm-btn-red adm-btn--sm" onClick={() => mutations.permanentDelete.mutate(item.sku, { onSuccess: () => onRefreshStats?.() })}>Delete</button>
          </>
        )}
      </div>
    </article>
  );
}

function Pager({ page, total, pageSize, onPageChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="adm-pager">
      <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Prev</button>
      <span>{page} / {pages} · {total} items</span>
      <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>Next</button>
    </div>
  );
}

function scrollToPageTop() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function withCurrentOption(options, currentId) {
  if (!currentId || options.some((o) => o.id === currentId)) return options;
  return [{ id: currentId, label: `${currentId} (missing)` }, ...options];
}

function productCategoryRowFromItem(item) {
  // No default to the first tree node — an uncategorised product must force
  // an explicit category pick, not silently go live under e.g. Arts & Crafts.
  const path = item.categoryPath || [];
  return {
    categoryId: path[0] || '',
    childIds: path.slice(1).filter(Boolean),
  };
}

function productListTitle(item, status) {
  const name = String(item.title || item.name || '').trim();
  if (name) return name;
  if (status === 'archived') return '—';
  return item.sku || '—';
}

function CodeEllipsis({ value, prefix = '' }) {
  const text = String(value || '').trim();
  if (!text) return <span>{prefix}—</span>;
  return (
    <span className="pm-code-ellipsis" title={text}>
      {prefix}
      {text}
    </span>
  );
}

/**
 * Search field that owns its own raw input value and only lifts the DEBOUNCED
 * term to the parent. Because it's a separate component, typing re-renders
 * just this small input — not the parent Product Manager and its ~50 product
 * rows — which is what made the search feel laggy (each keystroke reconciled
 * the whole un-virtualised list even though the row data hadn't changed).
 */
const PmSearchField = memo(function PmSearchField({ onDebouncedChange, initialValue = '', delay = 200 }) {
  const [value, setValue] = useState(initialValue);
  const onChangeRef = useRef(onDebouncedChange);
  onChangeRef.current = onDebouncedChange;
  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);
  useEffect(() => {
    const t = setTimeout(() => onChangeRef.current(value.trim()), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return (
    <label className="adm-search">
      <Search size={15} />
      <input
        type="search"
        className="adm-search-input"
        placeholder="Search SKU, barcode, title…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </label>
  );
});

export default function ProductManagerEngine({
  taxonomyTree = [],
  onShowToast,
  onRefreshStats,
  onEditProduct,
  onEditCategory,
  onAddCategory,
  onAddSubcategory,
  onDeleteSubcategory,
  onDeleteNode,
  onRefreshTaxonomy,
  onCategoryReorder,
  categoryProductCounts = {},
  initialStatus = 'live',
  statuses = CATALOG_STATUSES,
  showCategorySidebar = true,
  initialToOrderOnly = false,
  initialSearch = '',
  title = 'Product Manager',
  note = 'In-stock products are live on the site. Open a product to set its New Stock ribbon and To-order options.',
}) {
  const clampStatus = useCallback(
    (s) => (statuses.includes(s) ? s : statuses[0]),
    [statuses.join('|')], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [status, setStatus] = useState(() => clampStatus(initialStatus));
  const [archiveStockView, setArchiveStockView] = useState('archived');
  const [archiveSection, setArchiveSection] = useState('new-images');
  const [archiveSourceFilter, setArchiveSourceFilter] = useState('all');
  const [archivePrioritySkus, setArchivePrioritySkus] = useState(() => (
    initialStatus === 'archived' ? readArchivePrioritySkus() : []
  ));
  const reorderMode = false; // Reorder mode removed — use the Reorder Grid section instead.

  useEffect(() => {
    setStatus(clampStatus(initialStatus));
  }, [initialStatus, clampStatus]);

  useEffect(() => {
    if (initialStatus !== 'archived') return undefined;
    const refreshExcelPriority = (event) => {
      if (event.key === ARCHIVE_PRIORITY_STORAGE_KEY) {
        setArchivePrioritySkus(readArchivePrioritySkus());
      }
      if (event.key === CATALOG_MUTATED_STORAGE_KEY) {
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === 'catalog' && query.queryKey[1]?.status === 'archived',
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
      }
    };
    window.addEventListener('storage', refreshExcelPriority);
    return () => window.removeEventListener('storage', refreshExcelPriority);
  }, [initialStatus]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [onlyInStock, setOnlyInStock] = useState(() => readOnlyInStockPref());
  const [toOrderOnly, setToOrderOnly] = useState(() => Boolean(initialToOrderOnly));
  // SKU whose per-row "To order" toggle is mid-flight (for spinner + disable).
  const [toOrderPendingSku, setToOrderPendingSku] = useState(null);
  const [stockAvailablePendingSku, setStockAvailablePendingSku] = useState(null);
  // Only the debounced term lives here; the raw input value is owned by
  // PmSearchField so keystrokes don't re-render this component + its rows.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryPath, setCategoryPath] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [reorderProducts, setReorderProducts] = useState([]);
  const [reorderExpectedTotal, setReorderExpectedTotal] = useState(null);
  const [reorderLoading, setReorderLoading] = useState(false);
  const [sortOrderMeta, setSortOrderMeta] = useState({ updatedAt: null, storeUpdatedAt: null });
  const storeUpdatedAtRef = useRef(null);
  const [reorderDirty, setReorderDirty] = useState(false);
  const [catalogChangedWhileDirty, setCatalogChangedWhileDirty] = useState(false);
  const [reorderResyncNonce, setReorderResyncNonce] = useState(0);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [exportingSelected, setExportingSelected] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveSaving, setMoveSaving] = useState(false);
  const [selectAllView, setSelectAllView] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [bulkActionPending, setBulkActionPending] = useState(false);
  const [makeLiveItem, setMakeLiveItem] = useState(null);
  // childIds holds Child 1, Child 2, … as deep as the taxonomy tree goes — no
  // fixed level cap, so a product can be made live into a subcategory nested
  // past subcategory_four (stored in subcategory_extra).
  const [makeLiveCategory, setMakeLiveCategory] = useState({ categoryId: '', childIds: [] });
  const [makeLiveSaving, setMakeLiveSaving] = useState(false);
  const [categoryDrawerOpen, setCategoryDrawerOpen] = useState(false);
  const [categoryStackNav, setCategoryStackNav] = useState(null);
  const selectedRowsRef = useRef(new Map());
  const lastSelectIdxRef = useRef(null);
  const rowsRef = useRef([]);
  const panelTopRef = useRef(null);
  const reorderSaveTimerRef = useRef(null);
  const pendingReorderSaveRef = useRef(null);
  const reorderSyncKeyRef = useRef('');
  const catalogTotalWhileDirtyRef = useRef(null);
  const isMobile = useMediaQuery('(max-width: 900px)');

  useEffect(() => {
    setToOrderOnly(Boolean(initialToOrderOnly));
    setOnlyInStock(initialToOrderOnly ? false : readOnlyInStockPref());
    setPage(1);
    setCategoryPath([]);
  }, [initialToOrderOnly]);

  useEffect(() => {
    setDebouncedSearch(String(initialSearch || '').trim());
  }, [initialSearch]);

  const mutations = useCatalogMutations();
  const showStockColumn = STOCK_STATUSES.has(status);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    selectedRowsRef.current = new Map();
    lastSelectIdxRef.current = null;
    setSelectAllView(false);
  }, [status, debouncedSearch, categoryPath.join('/'), archiveStockView, archiveSection, archiveSourceFilter, onlyInStock, toOrderOnly]);

  // Any catalogue mutation (single-row or bulk archive/restore/delete/make-live)
  // changes category membership — refresh BOTH badge sources so the sidebar
  // counts never drift from the list. Debounced so a burst of per-row actions
  // coalesces into one counts refresh.
  useEffect(() => {
    let timer = null;
    const onMutated = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        onRefreshTaxonomy?.();
        setInStockCountsNonce((n) => n + 1);
      }, 400);
    };
    window.addEventListener('proto-catalog-mutated', onMutated);
    return () => {
      window.removeEventListener('proto-catalog-mutated', onMutated);
      if (timer) clearTimeout(timer);
    };
  }, [onRefreshTaxonomy]);

  const handleOnlyInStockChange = useCallback((next) => {
    setOnlyInStock(next);
    try {
      sessionStorage.setItem(ONLY_IN_STOCK_KEY, next ? '1' : '0');
    } catch { /* ignore */ }
  }, []);

  // Category badges must match what the list shows: when the stock toggle is
  // on, load stock-filtered counts; otherwise the parent-supplied counts
  // (all live rows) already match the default view.
  const [inStockCounts, setInStockCounts] = useState(null);
  const [inStockCountsNonce, setInStockCountsNonce] = useState(0);
  useEffect(() => {
    if (!(status === 'live' && onlyInStock)) {
      setInStockCounts(null);
      return undefined;
    }
    let cancelled = false;
    fetchCategoryProductCounts({ onlyInStock: true })
      .then((counts) => { if (!cancelled) setInStockCounts(counts); })
      .catch(() => { /* keep unfiltered counts as fallback */ });
    return () => { cancelled = true; };
  }, [status, onlyInStock, inStockCountsNonce]);
  const effectiveCategoryCounts = status === 'live' && onlyInStock && inStockCounts
    ? inStockCounts
    : categoryProductCounts;

  const handlePageChange = useCallback((nextPage) => {
    setPage(nextPage);
    lastSelectIdxRef.current = null;
    scrollToPageTop();
  }, []);

  const catalogParams = useMemo(() => buildCatalogParams({
    status,
    page,
    pageSize,
    search: debouncedSearch,
    // Search is catalogue-wide: a code/name query must find the product no
    // matter which category or subcategory is currently selected.
    categoryPath: debouncedSearch ? [] : categoryPath,
    stockFilter: status === 'archived' ? archiveStockView : undefined,
    archivedSource: status === 'archived' && archiveStockView === 'archived' ? archiveSourceFilter : undefined,
    archiveSection: status === 'archived' && archiveStockView === 'archived' ? archiveSection : undefined,
    prioritySkus: status === 'archived' && archiveStockView === 'archived' ? archivePrioritySkus : [],
    onlyInStock: status === 'live' && onlyInStock,
    toOrderOnly: status === 'live' && toOrderOnly,
  }), [status, page, pageSize, debouncedSearch, categoryPath, archiveStockView, archiveSection, archiveSourceFilter, archivePrioritySkus, onlyInStock, toOrderOnly]);

  const { data, isLoading, isFetching, isPlaceholderData } = useCatalogQuery(catalogParams);
  const rowsStale = Boolean(data && data.page !== page);
  const rows = rowsStale ? [] : (data?.rows || []);
  rowsRef.current = rows;
  const total = data?.total || 0;
  const archiveNegativeLive = status === 'archived' && archiveStockView === 'negative';

  // If an action shrinks the total (bulk archive/delete/move) while the admin
  // is on a high page, clamp back to the last real page — otherwise the server
  // returns an empty page and the admin is stranded on "No products in view"
  // with the pager reading e.g. "5 / 2".
  useEffect(() => {
    if (rowsStale || isFetching) return;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [total, pageSize, page, rowsStale, isFetching]);
  const tree = taxonomyTree.length ? taxonomyTree : (data?.tree || []);

  const categoryKey = categoryPath.length
    ? sortOrderCategoryKey(categoryPath, tree)
    : '__all__';

  // If the selected category node was deleted from the taxonomy, reset the
  // filter — an unresolvable path applies no server filter and would
  // silently show ALL products as if they belonged to the deleted category.
  useEffect(() => {
    if (!categoryPath.length || !tree.length) return;
    if (categoryPath[0] === '__uncategorized__') return;
    let nodes = tree;
    for (const id of categoryPath) {
      const node = (nodes || []).find((n) => n.id === id);
      if (!node) {
        setCategoryPath([]);
        return;
      }
      nodes = node.children || [];
    }
  }, [tree, categoryPath]);

  useEffect(() => {
    for (const row of rows) {
      if (selectedRowsRef.current.has(row.id)) {
        selectedRowsRef.current.set(row.id, row);
      }
    }
  }, [rows, page]);

  const loadSortOrder = useCallback(async (baseRows) => {
    if (!categoryPath.length || categoryKey === '__all__') return;
    try {
      const store = await fetchSortOrderStore({ force: true });
      const meta = sortMetaForPath(store, categoryPath, tree);
      setSortOrderMeta({ updatedAt: meta.updatedAt, storeUpdatedAt: store.updatedAt || null });
      storeUpdatedAtRef.current = store.updatedAt || null;
      const skuOrder = lookupSortOrder(store.orders || {}, categoryPath, tree);
      if (skuOrder?.length && baseRows?.length) {
        setReorderProducts(applySkuOrder(baseRows, skuOrder));
      }
    } catch { /* ignore */ }
  }, [categoryPath, categoryKey, tree]);

  const reorderSyncKey = `${reorderMode}|${status}|${categoryKey}`;

  useEffect(() => {
    if (!reorderMode || status !== 'live' || !categoryPath.length || categoryKey === '__all__') {
      reorderSyncKeyRef.current = '';
      setReorderExpectedTotal(null);
      setCatalogChangedWhileDirty(false);
      catalogTotalWhileDirtyRef.current = null;
      return undefined;
    }

    const syncKeyChanged = reorderSyncKeyRef.current !== reorderSyncKey;
    if (!syncKeyChanged && reorderDirty) return undefined;
    reorderSyncKeyRef.current = reorderSyncKey;

    let cancelled = false;
    setReorderLoading(true);
    setCatalogChangedWhileDirty(false);
    catalogTotalWhileDirtyRef.current = data?.total ?? null;
    fetchAllCatalogRows({ status: 'live', categoryPath, search: '', onlyInStock: false })
      .then((allRows) => {
        if (cancelled) return;
        setReorderExpectedTotal(allRows.length);
        setReorderProducts(allRows);
        setReorderDirty(false);
        void loadSortOrder(allRows);
      })
      .catch(() => {
        if (!cancelled) onShowToast?.('Failed to load full category for reorder', 'error');
      })
      .finally(() => {
        if (!cancelled) setReorderLoading(false);
      });
    return () => { cancelled = true; };
  }, [reorderSyncKey, reorderResyncNonce, reorderDirty, categoryPath, categoryKey, status, loadSortOrder, onShowToast, data?.total]);

  useEffect(() => {
    if (!reorderMode || status !== 'live' || !reorderDirty) return;
    const t = data?.total;
    if (t == null) return;
    if (catalogTotalWhileDirtyRef.current != null && catalogTotalWhileDirtyRef.current !== t) {
      setCatalogChangedWhileDirty(true);
    }
    catalogTotalWhileDirtyRef.current = t;
  }, [data?.total, reorderMode, status, reorderDirty]);

  const discardDirtyReorderSync = useCallback(() => {
    setCatalogChangedWhileDirty(false);
    setReorderDirty(false);
    reorderSyncKeyRef.current = '';
    catalogTotalWhileDirtyRef.current = null;
    setReorderResyncNonce((n) => n + 1);
  }, []);

  const reorderIncomplete = reorderExpectedTotal != null
    && reorderProducts.length !== reorderExpectedTotal;

  const handleReorderProductsChange = useCallback((nextOrFn) => {
    setReorderProducts((prev) => (typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn));
    setReorderDirty(true);
  }, []);

  const saveReorderOrder = async () => {
    if (debouncedSearch) {
      onShowToast?.('Clear search before saving sort order', 'error');
      return;
    }
    if (reorderIncomplete) {
      onShowToast?.('Category incomplete — reload before saving', 'error');
      return;
    }
    setReorderSaving(true);
    try {
      await persistOrder(reorderProducts);
      setReorderDirty(false);
    } finally {
      setReorderSaving(false);
    }
  };

  const persistOrder = async (next) => {
    if (!categoryKey || categoryKey === '__all__') {
      onShowToast?.('Select a category before saving sort order', 'error');
      return;
    }
    if (reorderExpectedTotal != null && next.length !== reorderExpectedTotal) {
      onShowToast?.('Category incomplete — reload before saving', 'error');
      return;
    }
    const skuOrder = next.map((p) => p.id);
    try {
      const json = await persistSortOrder({
        categoryKey,
        skuOrder,
        legacyKeys: sortOrderLookupKeys(categoryPath, tree).filter((k) => k !== categoryKey),
        expectedCategoryUpdatedAt: storeUpdatedAtRef.current,
      });
      setSortOrderMeta({ updatedAt: json.updatedAt, storeUpdatedAt: json.storeUpdatedAt || null });
      storeUpdatedAtRef.current = json.storeUpdatedAt || null;
      setTimeout(() => {
        void fetchSortMetaForCategory(categoryKey).then((meta) => {
          if (!meta?.updatedAt) return;
          setSortOrderMeta({ updatedAt: meta.updatedAt, storeUpdatedAt: meta.storeUpdatedAt || null });
          storeUpdatedAtRef.current = meta.storeUpdatedAt || null;
        });
      }, 5000);
      setReorderDirty(false);
      onShowToast?.('Sort order saved — live site updates within ~30s', 'success');
    } catch (err) {
      if (err.status === 409) {
        onShowToast?.(err.message || 'Reorder conflict — reload', 'error');
        void loadSortOrder(rowsRef.current);
        return;
      }
      onShowToast?.(err.message || 'Failed to save sort order', 'error');
      setReorderDirty(true);
    }
  };

  const scheduleReorderSave = useCallback((orderedProducts) => {
    pendingReorderSaveRef.current = orderedProducts;
    if (reorderSaveTimerRef.current) clearTimeout(reorderSaveTimerRef.current);
    reorderSaveTimerRef.current = setTimeout(() => {
      const pending = pendingReorderSaveRef.current;
      pendingReorderSaveRef.current = null;
      if (pending) void persistOrder(pending);
    }, 600);
  }, [categoryKey, categoryPath, tree, onShowToast, loadSortOrder]);

  useEffect(() => () => {
    if (reorderSaveTimerRef.current) clearTimeout(reorderSaveTimerRef.current);
  }, []);

  // Rows the admin selected by hand that are only in this category via a
  // placement. Bulk actions rewrite the PRIMARY category, so these need an
  // explicit warning before anything destructive runs.
  const placedOnlySelected = () => {
    const rows = [...selected].map((id) => selectedRowsRef.current.get(id)).filter(Boolean);
    return partitionPlacedOnly(rows, categoryPath).placedOnly;
  };

  const placedOnlyWarning = (verb) => {
    const placed = placedOnlySelected();
    if (!placed.length) return '';
    return `\n\nWARNING: ${placed.length} of these are only PLACED in this category — their main category is elsewhere. ${verb} will change their main category.`;
  };

  const confirmBulkMove = async ({ categoryPathIds, categoryId, subcategoryId, destinationLabel }) => {
    const skus = [...selected];
    if (!skus.length || categoryPathIds.length < 2) {
      onShowToast?.('Choose a main category and at least one subcategory', 'error');
      return;
    }
    if (!window.confirm(`Move ${skus.length} product(s) to:\n${destinationLabel}?${placedOnlyWarning('Moving')}`)) return;
    setMoveSaving(true);
    if (skus.length > LARGE_BULK_MOVE_THRESHOLD) {
      onShowToast?.(`Moving ${skus.length} products…`, 'info');
    }
    try {
      await bulkMoveProducts({ skus, categoryId, subcategoryId, categoryPathIds });
      setMoveModalOpen(false);
      clearSelection();
      setCategoryPath(categoryPathIds);
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
      // Same refresh rename/delete already do — category badges must update
      // immediately or the admin looks like it lied about the move.
      onRefreshTaxonomy?.();
      setInStockCountsNonce((n) => n + 1);
      onRefreshStats?.();
      onShowToast?.(`Moved ${skus.length} product(s) to ${destinationLabel}`, 'success');
    } catch (err) {
      if (err.status === 409) {
        setMoveModalOpen(false);
        clearSelection();
        onRefreshTaxonomy?.();
        onShowToast?.(err.message || 'Categories changed — reload and reselect', 'error');
      } else if (err.partial) {
        setMoveModalOpen(false);
        clearSelection();
        invalidateAdminCache();
        queryClient.invalidateQueries({ queryKey: ['catalog'] });
        // Some rows moved — refresh counts for the part that succeeded.
        onRefreshTaxonomy?.();
        setInStockCountsNonce((n) => n + 1);
        onShowToast?.(err.message || 'Move failed', 'warning');
      } else {
        onShowToast?.(err.message || 'Move failed', 'error');
      }
    } finally {
      setMoveSaving(false);
    }
  };

  // True only when every selected row is a known Mottaro product. Rows are
  // read from the selection cache; if any selected id isn't cached (e.g. a
  // cross-page select-all), we can't verify → treat as not-all-Mottaro.
  const selectionAllMottaro = useMemo(() => {
    if (selected.size === 0) return false;
    for (const id of selected) {
      const row = selectedRowsRef.current.get(id);
      if (!row || !(row.isMultiCategory || row.brandLine === 'Motarro')) return false;
    }
    return true;
  }, [selected]);

  // "Remove from this category" only makes sense for Mottaro products browsed
  // inside a normal category — never the virtual Mottaro tree (can't leave
  // Mottaro), never a mixed selection (would orphan non-Mottaro rows).
  const browsingMottaroTree = categoryPath[0] === 'mottaro';
  const canRemoveFromCategory = (status === 'live' || (status === 'archived' && !archiveNegativeLive))
    && categoryPath.length > 0
    && !browsingMottaroTree
    && selectionAllMottaro;

  const confirmRemoveFromCategory = async () => {
    const skus = [...selected];
    if (!skus.length) return;
    if (!window.confirm(
      `Remove ${skus.length} Motarro product(s) from this category?\n\nThey stay fully browsable under the Motarro brand tree — only their normal category is cleared.`,
    )) return;
    setBulkActionPending(true);
    try {
      const json = await bulkRemoveFromCategory({ skus });
      clearSelection();
      // Stay in the current category — the removed rows simply drop out of the
      // refreshed list (they no longer belong here).
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRefreshTaxonomy?.();
      setInStockCountsNonce((n) => n + 1);
      onShowToast?.(`Removed ${json.removed} product(s) from this category`, 'success');
    } catch (err) {
      if (err.partial) {
        clearSelection();
        invalidateAdminCache();
        queryClient.invalidateQueries({ queryKey: ['catalog'] });
        onRefreshTaxonomy?.();
        setInStockCountsNonce((n) => n + 1);
        onShowToast?.(err.message || 'Some products could not be removed', 'warning');
      } else {
        onShowToast?.(err.message || 'Remove from category failed', 'error');
      }
    } finally {
      setBulkActionPending(false);
    }
  };

  // Variant grouping (migration 052) — gated by the catalogGrouping flag.
  const [catalogGrouping, setCatalogGrouping] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeRows, setMergeRows] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/feature-flags')
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setCatalogGrouping(Boolean(j?.flags?.catalogGrouping)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const openMerge = () => {
    setMergeRows([...selected].map((id) => selectedRowsRef.current.get(id)).filter(Boolean));
    setMergeOpen(true);
  };
  const afterGroupChange = () => {
    clearSelection();
    invalidateAdminCache();
    queryClient.invalidateQueries({ queryKey: ['catalog'] });
    setInStockCountsNonce((n) => n + 1);
  };
  const ungroupSelected = async (groupId) => {
    if (!groupId) return;
    if (!window.confirm('Ungroup — split this back into separate product cards?')) return;
    setBulkActionPending(true);
    try {
      const res = await fetch(`/api/product-groups?groupId=${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Ungroup failed');
      onShowToast?.('Group split back into separate products', 'success');
      afterGroupChange();
    } catch (err) {
      onShowToast?.(err.message || 'Ungroup failed', 'error');
    } finally {
      setBulkActionPending(false);
    }
  };

  // Owner-only kill-switch for the whole variant-grouping feature. Flipping it
  // on reveals the Merge/Ungroup affordances here and collapses grouped SKUs on
  // the storefront; flipping it off is the instant rollback (data is kept).
  const [groupingToggleBusy, setGroupingToggleBusy] = useState(false);
  const toggleCatalogGrouping = async () => {
    const next = !catalogGrouping;
    if (!window.confirm(
      next
        ? 'Turn variant grouping ON? Merged groups will collapse into one storefront card.'
        : 'Turn variant grouping OFF? The catalogue reverts to one card per SKU (your groups are kept and re-appear when you turn it back on).',
    )) return;
    setGroupingToggleBusy(true);
    try {
      const res = await fetch('/api/feature-flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'catalogGrouping', value: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Failed (${res.status})`);
      setCatalogGrouping(Boolean(json?.flags?.catalogGrouping));
      onShowToast?.(`Variant grouping ${json?.flags?.catalogGrouping ? 'enabled' : 'disabled'}`, 'success');
      afterGroupChange();
    } catch (err) {
      onShowToast?.(err.message || 'Could not change variant grouping', 'error');
    } finally {
      setGroupingToggleBusy(false);
    }
  };

  const [floaterSweeping, setFloaterSweeping] = useState(false);
  const handleFloaterSweep = async () => {
    setFloaterSweeping(true);
    try {
      const preview = await previewFloaters();
      if (!preview.total) {
        onShowToast?.('No floaters found — every live product belongs to a category.', 'success');
        return;
      }
      const top = (preview.byCategory || []).slice(0, 8)
        .map((c) => `  • ${c.label}: ${c.count}`).join('\n');
      const more = (preview.byCategory || []).length > 8 ? `\n  …and ${preview.byCategory.length - 8} more label(s)` : '';
      const ok = window.confirm(
        `Found ${preview.total} floater product(s) that don't belong to any category `
        + `(${preview.byReason.empty} with no category, ${preview.byReason.unmatched} with an unknown category).\n\n`
        + `By category label:\n${top}${more}\n\n`
        + `Move all ${preview.total} to the Archive, tagged "floater"? `
        + `They stay restorable from the Archive. Motarro products are not affected.`,
      );
      if (!ok) return;
      const json = await archiveFloaters();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRefreshTaxonomy?.();
      setInStockCountsNonce((n) => n + 1);
      if (json.failed?.length) {
        onShowToast?.(`Archived ${json.archived} floater(s); ${json.failed.length} failed.`, 'warning');
      } else {
        onShowToast?.(`Archived ${json.archived} floater(s) — no more floaters.`, 'success');
      }
    } catch (err) {
      onShowToast?.(err.message || 'Floater sweep failed', 'error');
    } finally {
      setFloaterSweeping(false);
    }
  };

  // Deleted Motarro subcategories are hidden (virtual tree). Surface them for
  // restore while the admin is browsing the Motarro tree.
  const browsingMottaro = categoryPath[0] === 'mottaro';
  const [hiddenMottaro, setHiddenMottaro] = useState([]);
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [restoringId, setRestoringId] = useState('');
  useEffect(() => {
    if (!browsingMottaro) { setHiddenMottaro([]); return undefined; }
    let cancelled = false;
    listHiddenMottaro().then((ids) => { if (!cancelled) setHiddenMottaro(ids || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [browsingMottaro, taxonomyTree]);
  const mottaroHiddenLabel = (id) => String(id || '')
    .replace(/^mottaro-(other-)?/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || id;
  const handleRestoreMottaro = async (id) => {
    setRestoringId(id);
    try {
      await restoreMottaroNode(id);
      setHiddenMottaro((prev) => prev.filter((h) => h !== id));
      onRefreshTaxonomy?.();
      onShowToast?.(`Restored "${mottaroHiddenLabel(id)}" — its products stay archived until you restore them from the Archive.`, 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Restore failed', 'error');
    } finally {
      setRestoringId('');
    }
  };

  const handleProductSelect = useCallback((id, item, index, { shiftKey = false, ctrlKey = false } = {}) => {
    setSelectAllView(false);
    const currentRows = rowsRef.current;
    const idx = index !== null && index >= 0 ? index : null;

    if (shiftKey && lastSelectIdxRef.current !== null && idx !== null) {
      const start = Math.min(lastSelectIdxRef.current, idx);
      const end = Math.max(lastSelectIdxRef.current, idx);
      const rangeRows = currentRows.slice(start, end + 1);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const row of rangeRows) {
          next.add(row.id);
          selectedRowsRef.current.set(row.id, row);
        }
        return next;
      });
      return;
    }

    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        selectedRowsRef.current.delete(id);
      } else {
        next.add(id);
        if (item) selectedRowsRef.current.set(id, item);
      }
      return next;
    });
    if (!ctrlKey && idx !== null) lastSelectIdxRef.current = idx;
  }, []);

  const onProductCheckboxClick = useCallback((e, id, item, index) => {
    e.stopPropagation();
    handleProductSelect(id, item, index, {
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey || e.metaKey,
    });
  }, [handleProductSelect]);

  const onProductRowShiftClick = useCallback((e, id, item, index) => {
    if (!e.shiftKey) return;
    if (e.target.closest('button, a, input, label, .adm-icon-btn')) return;
    e.preventDefault();
    handleProductSelect(id, item, index, { shiftKey: true });
  }, [handleProductSelect]);

  const toggleToOrder = useCallback((item) => {
    if (!item?.sku || toOrderPendingSku) return;
    const next = !item.toOrder;
    setToOrderPendingSku(item.sku);
    mutations.setToOrder.mutate(
      { sku: item.sku, toOrder: next },
      {
        onSuccess: () => onShowToast?.(next ? 'Marked “To order”' : 'Removed “To order”', 'success'),
        onError: (err) => onShowToast?.(err.message || 'Could not update To-order', 'error'),
        onSettled: () => setToOrderPendingSku(null),
      },
    );
  }, [mutations, onShowToast, toOrderPendingSku]);

  const toggleStockAvailable = useCallback((item) => {
    if (!item?.sku || stockAvailablePendingSku) return;
    const stockAvailable = !item.stockAvailable;
    setStockAvailablePendingSku(item.sku);
    mutations.setStockAvailable.mutate(
      { sku: item.sku, stockAvailable },
      {
        onSuccess: () => onShowToast?.(stockAvailable ? 'Marked “Stock available”' : 'Stock available cleared', 'success'),
        onError: (err) => onShowToast?.(err.message || 'Could not update stock availability', 'error'),
        onSettled: () => setStockAvailablePendingSku(null),
      },
    );
  }, [mutations, onShowToast, stockAvailablePendingSku]);

  const toggleSelect = (id, item, opts = {}) => {
    handleProductSelect(id, item, opts.index ?? null, {
      shiftKey: opts.shiftKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
    });
  };

  const allPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedOnPage = rows.filter((r) => selected.has(r.id)).length;

  const clearSelection = () => {
    setSelected(new Set());
    selectedRowsRef.current = new Map();
    lastSelectIdxRef.current = null;
    setSelectAllView(false);
  };

  const toggleSelectAllPage = () => {
    if (allPageSelected) {
      setSelectAllView(false);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const item of rows) {
          next.delete(item.id);
          selectedRowsRef.current.delete(item.id);
        }
        return next;
      });
      return;
    }
    setSelectAllView(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of rows) {
        next.add(item.id);
        selectedRowsRef.current.set(item.id, item);
      }
      return next;
    });
  };

  const selectAllInView = async () => {
    setSelectingAll(true);
    try {
      // MUST mirror catalogParams exactly, or "Select all (N)" gathers a
      // different set than the list shows — e.g. omitting onlyInStock would
      // select (and then archive) out-of-stock rows the admin never saw, and
      // keeping categoryPath during a search would narrow the set below the
      // catalogue-wide list.
      const allRows = await fetchAllCatalogRows({
        status,
        search: debouncedSearch,
        categoryPath: debouncedSearch ? [] : categoryPath,
        stockFilter: status === 'archived' ? archiveStockView : undefined,
        archivedSource: status === 'archived' && archiveStockView === 'archived' ? archiveSourceFilter : undefined,
        archiveSection: status === 'archived' && archiveStockView === 'archived' ? archiveSection : undefined,
        onlyInStock: status === 'live' && onlyInStock,
      });
      // Products that are in this category only via an additional placement
      // are NOT selected. Bulk move/archive rewrite the PRIMARY category, so
      // sweeping them up here would silently destroy the real filing of a
      // product that lives somewhere else entirely.
      const browsePath = debouncedSearch ? [] : categoryPath;
      const { owned, placedOnly } = partitionPlacedOnly(allRows, browsePath);

      selectedRowsRef.current = new Map(owned.map((r) => [r.id, r]));
      setSelected(new Set(owned.map((r) => r.id)));
      setSelectAllView(true);
      onShowToast?.(
        placedOnly.length
          ? `Selected ${owned.length} product(s) — skipped ${placedOnly.length} only placed here (their main category is elsewhere)`
          : `Selected ${owned.length} product(s)`,
        'success',
      );
    } catch (err) {
      onShowToast?.(err.message || 'Failed to select all', 'error');
    } finally {
      setSelectingAll(false);
    }
  };

  const bulkArchiveSelected = async () => {
    const skus = [...selected];
    if (!skus.length) return;
    const noun = skus.length === 1 ? 'product' : 'products';
    if (!window.confirm(`Archive ${skus.length} selected ${noun}? They will be hidden from the trade website.${placedOnlyWarning('Archiving')}`)) return;
    setBulkActionPending(true);
    try {
      await mutations.bulkArchive.mutateAsync(skus);
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRefreshStats?.();
      onShowToast?.(`Archived ${skus.length} ${noun}`, 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Bulk archive failed', 'error');
    } finally {
      setBulkActionPending(false);
    }
  };

  const bulkEditProducts = useMemo(
    () => [...selected].map((id) => selectedRowsRef.current.get(id)).filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkEditOpen, selected],
  );

  const handleBulkEditSaved = () => {
    setSelected(new Set());
    selectedRowsRef.current = new Map();
    setBulkEditOpen(false);
    queryClient.invalidateQueries({ queryKey: ['catalog'] });
    onRefreshStats?.();
    // Bulk edit can change a product's category — refresh the sidebar badges
    // too (this path does not go through the mutations hook's event).
    onRefreshTaxonomy?.();
    setInStockCountsNonce((n) => n + 1);
  };

  // ONE request for the whole selection. The old runner looped mutateAsync per
  // SKU — hundreds of HTTP calls, each followed by a full catalogue-cache
  // invalidation — which produced the 5xx storms during big recycle runs.
  const runBulkBatch = async (mutateAsync, buildArg, { successMessage, confirmMessage } = {}) => {
    const skus = [...selected];
    if (!skus.length) return;
    if (confirmMessage && !window.confirm(confirmMessage(skus.length))) return;
    setBulkActionPending(true);
    try {
      const result = await mutateAsync(buildArg(skus));
      setSelected(new Set());
      onRefreshStats?.();
      if (result?.syncWarnings?.length) {
        onShowToast?.(syncWarningMessage(result.syncWarnings, { plural: skus.length > 1 }), 'warning');
      } else {
        onShowToast?.(successMessage?.(skus.length) || `${skus.length} updated`, 'success');
      }
    } catch (err) {
      // Partial failures arrive as "<n> ok, <m> failed — …" from the bulk API.
      onShowToast?.(err.message || 'Bulk action failed', 'warning');
      setSelected(new Set());
      onRefreshStats?.();
    } finally {
      setBulkActionPending(false);
    }
  };

  const makeLive = (item) => {
    // Categories get renamed/restructured often; pull the current tree so the
    // dropdown shows live categories with ids the server will still resolve
    // (a stale id is what triggers "Destination category changed").
    onRefreshTaxonomy?.();
    setMakeLiveItem(item);
    setMakeLiveCategory(productCategoryRowFromItem(item));
  };

  const confirmMakeLive = async () => {
    if (!makeLiveItem || makeLiveSaving) return;
    const path = [makeLiveCategory.categoryId, ...(makeLiveCategory.childIds || [])].filter(Boolean);
    if (!path.length) {
      onShowToast?.('Pick a main category before making live', 'error');
      return;
    }
    const name = productListTitle(makeLiveItem, 'archived');
    setMakeLiveSaving(true);
    try {
      await updateProduct(makeLiveItem.sku, { categoryPath: path });
      const restored = await mutations.unarchive.mutateAsync(makeLiveItem.sku);
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRefreshStats?.();
      const zeroStock = (makeLiveItem.stockOnHand ?? makeLiveItem.stockQty ?? 0) === 0;
      if (restored?.syncWarnings?.length) {
        onShowToast?.(syncWarningMessage(restored.syncWarnings), 'warning');
      } else {
        onShowToast?.(
          zeroStock
            ? `"${name}" is live and will stay visible at 0 stock — set price and stock on hand when ready.`
            : `"${name}" is now live on the website`,
          'success',
        );
      }
      setMakeLiveItem(null);
    } catch (err) {
      onShowToast?.(err.message || 'Make live failed', 'error');
    } finally {
      setMakeLiveSaving(false);
    }
  };

  const bulkMakeLive = async () => {
    const skus = [...selected];
    if (!skus.length) return;
    const noun = skus.length === 1 ? 'product' : 'products';
    if (!window.confirm(`Make ${skus.length} selected ${noun} live on the website?`)) return;
    setBulkActionPending(true);
    try {
      const result = await mutations.bulkUnarchive.mutateAsync(skus);
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onRefreshStats?.();
      if (result?.syncWarnings?.length) {
        onShowToast?.(syncWarningMessage(result.syncWarnings, { plural: skus.length > 1 }), 'warning');
      } else {
        onShowToast?.(`${skus.length} ${noun} now live`, 'success');
      }
    } catch (err) {
      onShowToast?.(err.message || 'Bulk restore failed', 'error');
    } finally {
      setBulkActionPending(false);
    }
  };

  const recycleSku = (sku, fromArchive) => mutations.softDelete.mutate(
    { sku, fromArchive },
    { onSuccess: () => onRefreshStats?.(), onError: (err) => onShowToast?.(err.message || 'Recycle failed', 'error') },
  );

  // mode: 'all' → every status/category; 'category' → the currently-clicked
  // category only (its subcategories included).
  const handleExportCatalog = async (mode = 'all') => {
    setExportingXlsx(true);
    try {
      const count = mode === 'all'
        ? await exportAllProductsCatalogXlsx({ taxonomyTree })
        : await exportProductsCatalogXlsx({ status, taxonomyTree, categoryPath });
      onShowToast?.(`Exported ${count} product${count === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Export failed', 'error');
    } finally {
      setExportingXlsx(false);
    }
  };

  const handleExportSelected = async () => {
    const products = [...selected]
      .map((id) => selectedRowsRef.current.get(id))
      .filter(Boolean);
    if (!selected.size) {
      onShowToast?.('Select at least one product', 'error');
      return;
    }
    setExportingSelected(true);
    try {
      const count = await exportSelectedProductsXlsx(products, {
        status,
        taxonomyTree,
        selectedIds: [...selected],
      });
      onShowToast?.(`Exported ${count} selected product${count === 1 ? '' : 's'} to Excel`, 'success');
    } catch (err) {
      onShowToast?.(err.message || 'Export failed', 'error');
    } finally {
      setExportingSelected(false);
    }
  };

  const showSkeleton = (isLoading && !isPlaceholderData && !data) || (rowsStale && isFetching);
  const addSubParentId = categoryPath[0] || tree[0]?.id || '';
  const categoryLabels = useMemo(() => resolvePathLabels(tree, categoryPath), [tree, categoryPath]);
  const categoryFilterLabel = categoryLabels.length
    ? categoryLabels.join(' › ')
    : 'All categories';

  useEffect(() => {
    if (!categoryDrawerOpen) {
      setCategoryStackNav(null);
    }
  }, [categoryDrawerOpen]);

  useEffect(() => {
    if (!categoryDrawerOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [categoryDrawerOpen]);

  const handleCategoryStackNavChange = useCallback((nav) => {
    setCategoryStackNav(nav);
  }, []);

  const handleCategorySelect = useCallback((path) => {
    setCategoryPath(path);
    if (isMobile) setCategoryDrawerOpen(false);
  }, [isMobile]);

  return (
    <div ref={panelTopRef} className="adm-panel adm-panel-with-sidebar pm-engine">
      <div className="adm-section-head">
        <div>
          <h2 className="adm-section-title">{title}</h2>
          <p className="adm-section-note">{note}</p>
        </div>
        <div className="pm-engine-head-actions">
          {!reorderMode && (
            <>
              <button
                type="button"
                className="adm-btn-ghost adm-btn--sm"
                disabled={exportingXlsx}
                onClick={() => void handleExportCatalog('category')}
                title={categoryPath.length
                  ? `Export only "${categoryFilterLabel}" (and its subcategories)`
                  : `Export all ${status === 'archived' ? 'archived' : 'live'} products`}
              >
                {exportingXlsx ? <Loader2 size={14} className="spin" /> : <FileSpreadsheet size={14} />}
                {exportingXlsx
                  ? 'Exporting…'
                  : (categoryPath.length
                    ? `Export ${categoryLabels[categoryLabels.length - 1]}`
                    : `Export ${status === 'archived' ? 'archived' : 'live'}`)}
              </button>
              <button
                type="button"
                className="adm-btn-ghost adm-btn--sm"
                disabled={exportingXlsx}
                onClick={() => void handleExportCatalog('all')}
                title="Export live + archived + recycle in one file, plus category tree sheet"
              >
                {exportingXlsx ? <Loader2 size={14} className="spin" /> : <FileSpreadsheet size={14} />}
                Export all
              </button>
            </>
          )}
          {status === 'live' && !reorderMode && (
            <button
              type="button"
              className="adm-btn-ghost adm-btn--sm"
              style={catalogGrouping ? { background: '#0f766e', color: '#fff', borderColor: '#0f766e' } : undefined}
              disabled={groupingToggleBusy}
              onClick={() => void toggleCatalogGrouping()}
              title={catalogGrouping
                ? 'Variant grouping is ON — click to turn off (groups are kept). Owner only.'
                : 'Variant grouping is OFF — click to turn on so merged SKUs collapse into one card. Owner only.'}
            >
              {groupingToggleBusy
                ? <Loader2 size={14} className="spin" />
                : <Layers size={14} />}
              Variant grouping: {catalogGrouping ? 'On' : 'Off'}
            </button>
          )}
          {isFetching && !isLoading && <Loader2 size={16} className="spin" aria-label="Refreshing" />}
        </div>
      </div>

      {statuses.length > 1 && (
        <div className="adm-customer-tabs pm-status-tabs">
          {statuses.map((s) => {
            const meta = STATUS_META[s];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <button
                key={s}
                type="button"
                className={`adm-tab${status === s ? ' adm-tab--active' : ''}`}
                onClick={() => setStatus(s)}
              >
                <Icon size={14} /> {meta.label}
              </button>
            );
          })}
        </div>
      )}

      {(
        <div className={`adm-panel-split${showCategorySidebar ? '' : ' adm-panel-split--no-sidebar'}`}>
          {showCategorySidebar && (
          <aside className={`adm-panel-sidebar adm-reorder-tree-sidebar${isMobile ? ' adm-panel-sidebar--desktop-only' : ''}`}>
            <div className="adm-reorder-cat-heading">
              <span>Categories</span>
              <span style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto' }}>
                {onAddSubcategory && addSubParentId && (
                  <button
                    type="button"
                    className="adm-taxonomy-add-btn"
                    title="Add subcategory to selected category"
                    onClick={() => onAddSubcategory(addSubParentId)}
                  >
                    <Plus size={16} strokeWidth={2.5} />
                  </button>
                )}
                {onAddCategory && (
                  <button
                    type="button"
                    className="adm-taxonomy-add-btn"
                    title="Add new category"
                    onClick={() => onAddCategory()}
                  >
                    <FolderPlus size={16} strokeWidth={2.5} />
                  </button>
                )}
              </span>
            </div>
            <CategorySidebar
              tree={tree}
              selectedPath={categoryPath}
              onSelectPath={handleCategorySelect}
              onEditNode={onEditCategory}
              onDeleteNode={onDeleteNode}
              onAddChild={onAddSubcategory}
              onReorder={onCategoryReorder}
              productCounts={effectiveCategoryCounts}
              showUncategorized={(effectiveCategoryCounts.__uncategorized__ || 0) > 0}
            />
          </aside>
          )}
          <div className="adm-panel-main">
            {isMobile && showCategorySidebar && (
              <div className="pm-mobile-cat-bar">
                <button
                  type="button"
                  className="pm-cat-trigger"
                  onClick={() => setCategoryDrawerOpen(true)}
                >
                  <FolderTree size={18} />
                  <span className="pm-cat-trigger-label">{categoryFilterLabel}</span>
                  <ChevronRight size={18} className="pm-cat-trigger-chevron" />
                </button>
                {categoryPath.length > 0 && (
                  <button
                    type="button"
                    className="pm-cat-clear"
                    onClick={() => setCategoryPath([])}
                  >
                    Clear filter
                  </button>
                )}
              </div>
            )}
            <div className="adm-toolbar pm-toolbar">
              {status === 'archived' && (
                <>
                  <p className="adm-section-note" style={{ margin: '0 0 8px', width: '100%' }}>
                    {archiveStockView === 'negative'
                      ? 'Live products with negative ERP stock. Zero-stock items are not shown here.'
                      : archiveSection === 'new-images'
                        ? 'New products Catherine sent to Archive from an image intake today. Nothing in this view is live until Make live is confirmed.'
                        : 'Previously archived products. New image intakes from today are kept in the separate New image items view.'}
                  </p>
                  <div className="pm-archive-stock-toggle" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%', marginBottom: 8 }}>
                    <button
                      type="button"
                      aria-pressed={archiveStockView === 'archived' && archiveSection === 'new-images'}
                      className={`adm-btn-ghost adm-btn--sm${archiveStockView === 'archived' && archiveSection === 'new-images' ? ' adm-tab--active' : ''}`}
                      onClick={() => { setArchiveStockView('archived'); setArchiveSection('new-images'); setArchiveSourceFilter('all'); }}
                    >
                      New image items
                    </button>
                    <button
                      type="button"
                      aria-pressed={archiveStockView === 'archived' && archiveSection === 'older'}
                      className={`adm-btn-ghost adm-btn--sm${archiveStockView === 'archived' && archiveSection === 'older' ? ' adm-tab--active' : ''}`}
                      onClick={() => { setArchiveStockView('archived'); setArchiveSection('older'); }}
                    >
                      Older archive
                    </button>
                    <button
                      type="button"
                      aria-pressed={archiveStockView === 'negative'}
                      className={`adm-btn-ghost adm-btn--sm${archiveStockView === 'negative' ? ' adm-tab--active' : ''}`}
                      onClick={() => setArchiveStockView('negative')}
                    >
                      Negative stock
                    </button>
                    {archiveStockView === 'archived' && archiveSection === 'older' && (
                      <>
                        <button
                          type="button"
                          className={`adm-btn-ghost adm-btn--sm${archiveSourceFilter === 'all' ? ' adm-tab--active' : ''}`}
                          onClick={() => setArchiveSourceFilter('all')}
                        >
                          All archived
                        </button>
                        <button
                          type="button"
                          className={`adm-btn-ghost adm-btn--sm${archiveSourceFilter === 'nutstore' ? ' adm-tab--active' : ''}`}
                          onClick={() => setArchiveSourceFilter('nutstore')}
                        >
                          Nutstore
                        </button>
                        <button
                          type="button"
                          className={`adm-btn-ghost adm-btn--sm${archiveSourceFilter === 'other' ? ' adm-tab--active' : ''}`}
                          onClick={() => setArchiveSourceFilter('other')}
                        >
                          Other
                        </button>
                      </>
                    )}
                    {!isLoading && (
                      <span className="adm-pill" style={{ marginLeft: 'auto', fontSize: 12 }}>
                        {total} product{total === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </>
              )}
              <PmSearchField initialValue={initialSearch} onDebouncedChange={setDebouncedSearch} />
              {status === 'live' && (
                <FilterMenu
                  label="Filter"
                  options={[
                    {
                      key: 'in-stock',
                      label: 'In stock only',
                      hint: 'Hide products with zero available stock',
                      checked: onlyInStock,
                      accentColor: '#8B1A1A',
                      onChange: (v) => handleOnlyInStockChange(v),
                    },
                    !initialToOrderOnly && {
                      key: 'to-order',
                      label: 'To order only',
                      hint: 'Only products marked “To order” (orderable at 0 stock)',
                      checked: toOrderOnly,
                      accentColor: '#b45309',
                      onChange: (v) => { setToOrderOnly(v); setPage(1); },
                    },
                  ].filter(Boolean)}
                />
              )}
              {!reorderMode && (
                <ActionMenu
                  label="Maintenance"
                  items={[
                    (status === 'live') && {
                      label: floaterSweeping ? 'Scanning…' : 'Clean up floaters',
                      icon: floaterSweeping ? <Loader2 size={14} className="spin" /> : <FolderMinus size={14} />,
                      disabled: floaterSweeping,
                      onClick: () => void handleFloaterSweep(),
                    },
                    (browsingMottaro && hiddenMottaro.length > 0) && {
                      label: `Restore deleted (${hiddenMottaro.length})`,
                      icon: <RotateCcw size={14} />,
                      onClick: () => setRestoreModalOpen(true),
                    },
                  ].filter(Boolean)}
                />
              )}
              {rows.length > 0 && !reorderMode && (
                <div className="pm-select-toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
                  {total > rows.length && (
                    <button
                      type="button"
                      className="adm-btn-ghost adm-btn--sm"
                      disabled={selectingAll}
                      onClick={() => void selectAllInView()}
                    >
                      {selectingAll ? <><Loader2 size={14} className="spin" /> Loading…</> : `Select all (${total})`}
                    </button>
                  )}
                  {selected.size > 0 && (
                    <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={clearSelection}>
                      Clear
                    </button>
                  )}
                </div>
              )}
              {selectAllView && selected.size > 0 && (
                <div className="pm-select-all-banner adm-bulk-bar" style={{ width: '100%', marginBottom: 0 }}>
                  <span>All {selected.size} products in this view are selected.</span>
                  <button type="button" className="adm-bulk-bar__link" onClick={clearSelection}>Clear selection</button>
                </div>
              )}
              {selected.size > 0 && (
                <div className="pm-bulk-bar">
                  <span className="pm-bulk-bar__count">
                    {selected.size} selected
                    {total > rows.length && selectedOnPage < selected.size && (
                      <span className="pm-bulk-bar__count-sub"> · {selectedOnPage} on this page</span>
                    )}
                  </span>

                  <div className="pm-bulk-group">
                    {canRemoveFromCategory && (
                      <button
                        type="button"
                        className="adm-btn-ghost adm-btn--sm"
                        disabled={bulkActionPending}
                        onClick={() => void confirmRemoveFromCategory()}
                        title="Detach these Motarro products from this category — they stay in the Motarro brand tree"
                      >
                        <FolderMinus size={14} /> Remove from category
                      </button>
                    )}
                    {(status === 'live' || status === 'archived') && (
                      <button
                        type="button"
                        className="adm-btn-ghost adm-btn--sm"
                        onClick={() => setBulkEditOpen(true)}
                      >
                        <Pencil size={14} /> Bulk edit
                      </button>
                    )}
                    {(status === 'live' || status === 'archived') && (
                      <button
                        type="button"
                        className="adm-btn-ghost adm-btn--sm"
                        disabled={moveSaving || bulkActionPending}
                        onClick={() => setMoveModalOpen(true)}
                        title="Move the selected products to another category"
                      >
                        <FolderTree size={14} /> Move
                      </button>
                    )}
                    {status === 'live' && catalogGrouping && selected.size >= 2 && (
                      <button
                        type="button"
                        className="adm-btn-ghost adm-btn--sm"
                        onClick={openMerge}
                        title="Merge these products into one storefront card with a variant selector"
                      >
                        <Layers size={14} /> Merge into group
                      </button>
                    )}
                    {status === 'live' && catalogGrouping && selected.size === 1 && (() => {
                      const row = selectedRowsRef.current.get([...selected][0]);
                      return row?.variantGroup?.isPrimary ? (
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn--sm"
                          disabled={bulkActionPending}
                          onClick={() => void ungroupSelected(row.variantGroup.groupId)}
                          title="Split this group back into separate product cards"
                        >
                          <Layers size={14} /> Ungroup
                        </button>
                      ) : null;
                    })()}
                  </div>

                  <div className="pm-bulk-group pm-bulk-group--end">
                    {(status === 'live' || (status === 'archived' && archiveNegativeLive)) && (
                      <>
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn--sm"
                          disabled={bulkActionPending}
                          onClick={() => void bulkArchiveSelected()}
                        >
                          {bulkActionPending ? 'Archiving…' : `Archive ${selected.size}`}
                        </button>
                        <button type="button" className="adm-btn-red adm-btn--sm" disabled={bulkActionPending} onClick={() => void runBulkBatch(mutations.bulkRecycle.mutateAsync, (skus) => ({ skus, fromArchive: false }), { successMessage: (n) => `${n} moved to recycle bin` })}>To recycle</button>
                      </>
                    )}
                    {status === 'archived' && !archiveNegativeLive && (
                      <>
                        <button
                          type="button"
                          className="adm-btn-red adm-btn--sm"
                          disabled={bulkActionPending}
                          onClick={() => void bulkMakeLive()}
                        >
                          {bulkActionPending
                            ? 'Restoring…'
                            : (
                              <>
                                <ArchiveRestore size={14} />
                                {' '}
                                Make {selected.size} live
                              </>
                            )}
                        </button>
                        <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={bulkActionPending} onClick={() => void runBulkBatch(mutations.bulkRecycle.mutateAsync, (skus) => ({ skus, fromArchive: true }), { successMessage: (n) => `${n} moved to recycle bin` })}>To recycle</button>
                      </>
                    )}
                    {status === 'recycle' && (
                      <>
                        <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={bulkActionPending} onClick={() => void runBulkBatch(mutations.bulkRestoreRecycle.mutateAsync, (skus) => skus, { successMessage: (n) => `${n} restored` })}>Restore</button>
                        <button type="button" className="adm-btn-red adm-btn--sm" disabled={bulkActionPending} onClick={() => void runBulkBatch(mutations.bulkPermanentDelete.mutateAsync, (skus) => skus, { successMessage: (n) => `${n} deleted forever`, confirmMessage: (n) => `Permanently delete ${n} product${n === 1 ? '' : 's'}? This cannot be undone.` })}>Delete forever</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {showSkeleton ? <CatalogSkeleton /> : (
              <>
                {isMobile ? (
                  <div className="pm-mobile-list">
                    {rows.map((item, index) => (
                      <PmMobileProductCard
                        key={item.id}
                        item={item}
                        index={index}
                        status={archiveNegativeLive ? 'live' : status}
                        selected={selected}
                        showStockColumn={showStockColumn}
                        onCheckboxClick={onProductCheckboxClick}
                        onRowShiftClick={onProductRowShiftClick}
                        onEditProduct={onEditProduct}
                        onMakeLive={makeLive}
                        mutations={mutations}
                        onRefreshStats={onRefreshStats}
                        recycleSku={recycleSku}
                        onShowToast={onShowToast}
                        onToggleToOrder={toggleToOrder}
                        toOrderPendingSku={toOrderPendingSku}
                        onToggleStockAvailable={toggleStockAvailable}
                        stockAvailablePendingSku={stockAvailablePendingSku}
                        tree={tree}
                      />
                    ))}
                    {!rows.length && !isLoading && (
                      <p className="adm-empty">
                        {status === 'archived' && archiveStockView === 'negative'
                          ? 'No live products with negative stock.'
                          : status === 'archived'
                            ? archiveSection === 'new-images'
                              ? 'No new image items have been sent to Archive today.'
                              : 'No older archived products (zero-stock items are hidden).'
                            : 'No products in this view.'}
                      </p>
                    )}
                  </div>
                ) : (
                <>
                <p className="adm-muted pm-shift-hint" style={{ fontSize: 12, margin: '0 0 8px' }}>
                  Checkboxes to select · <strong>Shift+click</strong> a second row/checkbox for a range · <strong>Ctrl/Cmd+click</strong> to toggle without moving the anchor
                </p>
                <div className="adm-list pm-list">
                  <div
                    className="adm-list-head pm-list-head"
                    style={{ gridTemplateColumns: ROW_COLUMNS[status] || ROW_COLUMNS.live }}
                  >
                    <span>
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={toggleSelectAllPage}
                        style={{ accentColor: '#8B1A1A', cursor: 'pointer' }}
                        aria-label="Select all products on this page"
                      />
                    </span>
                    <span />
                    <span>Product</span>
                    {showStockColumn && <span>Stock</span>}
                    <span>Actions</span>
                  </div>
                  {rows.map((item, index) => (
                    <div
                      key={item.id}
                      className={`adm-list-row${selected.has(item.id) ? ' adm-list-row--selected' : ''}`}
                      style={{ gridTemplateColumns: ROW_COLUMNS[status] || ROW_COLUMNS.live }}
                      onClick={(e) => onProductRowShiftClick(e, item.id, item, index)}
                    >
                      <div>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onClick={(e) => onProductCheckboxClick(e, item.id, item, index)}
                          readOnly
                          style={{ accentColor: '#8B1A1A', cursor: 'pointer' }}
                          aria-label={`Select ${item.sku}`}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        {item.image ? (
                          <img src={item.image} alt="" loading="lazy" decoding="async" className="adm-product-thumb" />
                        ) : (
                          <div className="adm-product-thumb adm-product-thumb--placeholder">IMG</div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {productListTitle(item, status)}
                          {!item.image && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '1px 5px' }}>No image</span>
                          )}
                          {item.isNew && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#0f766e', borderRadius: 4, padding: '1px 5px' }}>Special</span>
                          )}
                          {item.toOrder && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#b45309', borderRadius: 4, padding: '1px 5px' }}>To order</span>
                          )}
                          {item.stockAvailable && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#0369a1', borderRadius: 4, padding: '1px 5px' }}>Stock available</span>
                          )}
                          {item.variantGroup?.isPrimary && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#6d28d9', borderRadius: 4, padding: '1px 5px' }} title="Variant group — shows as one card on the site">
                              {item.variantGroup.variantCount ? `${item.variantGroup.variantCount} variants` : 'Group'}
                            </span>
                          )}
                          <NutstoreArchiveBadge archivedBy={item.archivedBy} />
                          <NeedsSohPriceBadge item={item} />
                          <OutOfStockLinkedBadge item={item} />
                          <MultiCategoryBadge item={item} tree={tree} />
                          <MovedBadge item={item} />
                        </div>
                        <div className="adm-muted" style={{ fontSize: 11 }}>
                          <span>BC: <CodeEllipsis value={item.barcode || item.code} /></span>
                          {item.sku && (
                            <span style={{ marginLeft: 8 }}>
                              WSK: <CodeEllipsis value={item.sku} />
                            </span>
                          )}
                          {item.price > 0 && (
                            <span title="Price incl. VAT" style={{ marginLeft: 8, fontWeight: 700, color: '#374151' }}>
                              R{formatWebsitePrice(item.price)}
                            </span>
                          )}
                          {item.toOrder && (
                            <span title="Customer selling unit" style={{ marginLeft: 8, fontWeight: 700, color: '#92400e' }}>
                              Unit: {sellingUnitLabel(item.unitsOfIssue)}
                            </span>
                          )}
                          {item.toOrder && (
                            <span title="Minimum selling units per order" style={{ marginLeft: 8, fontWeight: 700, color: '#92400e' }}>
                              Minimum: {Math.max(1, Number(item.minQty) || 1)}
                            </span>
                          )}
                        </div>
                        <ProductCategoryLine item={item} tree={tree} />
                      </div>
                      {showStockColumn && (
                        <div>
                          <span style={{
                            fontWeight: status === 'archived' ? 900 : 700,
                            fontSize: status === 'archived' ? 15 : undefined,
                            color: item.stockQty < 0
                              ? '#b91c1c'
                              : (status === 'archived' ? '#8B1A1A' : undefined),
                          }}
                          >
                            {formatStockUnits(item.stockQty)}
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {onEditProduct && (
                          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => onEditProduct(item)}>
                            <Pencil size={14} /> Edit
                          </button>
                        )}
                        {status === 'live' && (
                          <>
                            <button
                              type="button"
                              className={`adm-btn-ghost adm-btn--sm${item.toOrder ? ' pm-toorder-btn--on' : ''}`}
                              aria-pressed={!!item.toOrder}
                              disabled={toOrderPendingSku === item.sku}
                              title={item.toOrder ? 'Marked “To order” — click to turn off' : 'Mark “To order” (orderable at 0 stock)'}
                              onClick={() => toggleToOrder(item)}
                            >
                              {toOrderPendingSku === item.sku ? <Loader2 size={14} className="spin" /> : <PackagePlus size={14} />}
                              To order
                            </button>
                            <button
                              type="button"
                              className={`adm-btn-ghost adm-btn--sm${item.stockAvailable ? ' pm-stockavailable-btn--on' : ''}`}
                              aria-pressed={!!item.stockAvailable}
                              disabled={stockAvailablePendingSku === item.sku}
                              title={item.stockAvailable ? 'Stock available — click to turn off' : "Mark recently arrived stock as available"}
                              onClick={() => toggleStockAvailable(item)}
                            >
                              {stockAvailablePendingSku === item.sku ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />}
                              Stock available
                            </button>
                            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => mutations.archive.mutate(item.sku, { onSuccess: () => onRefreshStats?.(), onError: (err) => onShowToast?.(err.message || 'Archive failed', 'error') })}>Archive</button>
                            <button type="button" className="adm-btn-red adm-btn--sm" title="Move to recycle bin" aria-label="Move to recycle bin" onClick={() => recycleSku(item.sku, false)}><Trash2 size={14} /></button>
                          </>
                        )}
                        {status === 'archived' && archiveNegativeLive && (
                          <>
                            <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => mutations.archive.mutate(item.sku, { onSuccess: () => onRefreshStats?.(), onError: (err) => onShowToast?.(err.message || 'Archive failed', 'error') })}>Archive</button>
                            <button type="button" className="adm-btn-red adm-btn--sm" title="Move to recycle bin" aria-label="Move to recycle bin" onClick={() => recycleSku(item.sku, false)}><Trash2 size={14} /></button>
                          </>
                        )}
                        {status === 'archived' && !archiveNegativeLive && (
                          <>
                            <button type="button" className="adm-btn-red adm-btn--sm" onClick={() => makeLive(item)}>
                              <ArchiveRestore size={14} /> Make live
                            </button>
                            <button type="button" className="adm-btn-ghost adm-btn--sm" title="Move to recycle bin" aria-label="Move to recycle bin" onClick={() => recycleSku(item.sku, true)}><Trash2 size={14} /></button>
                          </>
                        )}
                        {status === 'recycle' && (
                          <>
                            <button
                              type="button"
                              className="adm-btn-ghost adm-btn--sm"
                              onClick={() => mutations.restoreRecycle.mutate(item.sku, {
                                onSuccess: (data) => {
                                  onRefreshStats?.();
                                  if (data?.syncWarnings?.length) onShowToast?.(syncWarningMessage(data.syncWarnings), 'warning');
                                },
                              })}
                            >
                              <ArchiveRestore size={14} /> Restore
                            </button>
                            <button type="button" className="adm-btn-red adm-btn--sm" onClick={() => mutations.permanentDelete.mutate(item.sku, { onSuccess: () => onRefreshStats?.() })}>Delete forever</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {!rows.length && !isLoading && (
                    <p className="adm-empty">
                      {status === 'archived' && archiveStockView === 'negative'
                        ? 'No live products with negative stock.'
                        : status === 'archived'
                          ? 'No archived products (zero-stock items are hidden).'
                          : 'No products in this view.'}
                    </p>
                  )}
                </div>
                </>
                )}
                <Pager page={page} total={total} pageSize={pageSize} onPageChange={handlePageChange} />
              </>
            )}
          </div>
        </div>
      )}

      {isMobile && showCategorySidebar && categoryDrawerOpen && (
        <>
          <button
            type="button"
            className="pm-cat-drawer-backdrop"
            aria-label="Close categories"
            onClick={() => setCategoryDrawerOpen(false)}
          />
          <div className="pm-cat-drawer" role="dialog" aria-modal="true" aria-label="Browse categories">
            <div className="pm-cat-drawer-head">
              {categoryStackNav?.canGoBack ? (
                <span className="pm-cat-drawer-head-title pm-cat-drawer-head-title--sub">
                  {categoryStackNav.currentFolderLabel}
                </span>
              ) : (
                <strong>Categories</strong>
              )}
              <div className="pm-cat-drawer-head-actions">
                {onAddSubcategory && addSubParentId && (
                  <button
                    type="button"
                    className="adm-taxonomy-add-btn"
                    title="Add subcategory"
                    onClick={() => onAddSubcategory(addSubParentId)}
                  >
                    <Plus size={16} strokeWidth={2.5} />
                  </button>
                )}
                {onAddCategory && (
                  <button
                    type="button"
                    className="adm-taxonomy-add-btn"
                    title="Add category"
                    onClick={() => onAddCategory()}
                  >
                    <FolderPlus size={16} strokeWidth={2.5} />
                  </button>
                )}
                <button
                  type="button"
                  className="pm-cat-drawer-close"
                  aria-label="Close"
                  onClick={() => setCategoryDrawerOpen(false)}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            {categoryStackNav?.canGoBack && (
              <div className="pm-cat-drawer-nav">
                <button
                  type="button"
                  className="pm-cat-drawer-back"
                  onClick={categoryStackNav.goBack}
                >
                  <ChevronLeft size={22} strokeWidth={2.5} />
                  <span>Back to {categoryStackNav.parentFolderLabel}</span>
                </button>
              </div>
            )}
            <CategorySidebar
              tree={tree}
              selectedPath={categoryPath}
              onSelectPath={handleCategorySelect}
              onEditNode={onEditCategory}
              onDeleteNode={onDeleteNode}
              onAddChild={onAddSubcategory}
              onReorder={onCategoryReorder}
              variant="stack"
              className="pm-cat-drawer-sidebar"
              isActive={categoryDrawerOpen}
              onStackNavChange={handleCategoryStackNavChange}
              productCounts={effectiveCategoryCounts}
              showUncategorized={(effectiveCategoryCounts.__uncategorized__ || 0) > 0}
            />
          </div>
        </>
      )}

      {bulkEditOpen && bulkEditProducts.length > 0 && (
        <BulkProductEditModal
          products={bulkEditProducts}
          taxonomyTree={tree}
          onClose={() => setBulkEditOpen(false)}
          onSaved={handleBulkEditSaved}
          onShowToast={onShowToast}
          onRefreshTaxonomy={onRefreshTaxonomy}
        />
      )}

      <MergeIntoGroupModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        rows={mergeRows}
        onCreated={afterGroupChange}
        onShowToast={onShowToast}
      />

      <BulkMoveModal
        open={moveModalOpen}
        count={selected.size}
        taxonomyTree={tree}
        initialCategoryId={categoryPath[0] || tree[0]?.id || ''}
        saving={moveSaving}
        onClose={() => setMoveModalOpen(false)}
        onConfirm={(payload) => void confirmBulkMove(payload)}
        onAddSubcategory={(parentId) => {
          setMoveModalOpen(false);
          onAddSubcategory?.(parentId);
        }}
      />

      {restoreModalOpen && (
        <div className="adm-modal-backdrop" onClick={() => setRestoreModalOpen(false)}>
          <div className="adm-modal adm-modal--form" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Restore deleted Motarro subcategories</h3>
              <button type="button" className="adm-modal-close" onClick={() => setRestoreModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="adm-modal-body">
              <p className="adm-modal-note">
                Restoring re-shows the subcategory. Products archived when it was deleted
                stay in the Archive — restore them from the Archive tab if you want them live again.
              </p>
              {hiddenMottaro.length === 0 ? (
                <p className="adm-muted">No deleted Motarro subcategories.</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {hiddenMottaro.map((id) => (
                    <li key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ fontWeight: 600 }}>{mottaroHiddenLabel(id)}</span>
                      <button
                        type="button"
                        className="adm-btn-ghost adm-btn--sm"
                        disabled={restoringId === id}
                        onClick={() => void handleRestoreMottaro(id)}
                      >
                        {restoringId === id ? <><Loader2 size={14} className="spin" /> Restoring…</> : <><RotateCcw size={14} /> Restore</>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
      {makeLiveItem && (
        <div className="adm-modal-backdrop" onClick={() => !makeLiveSaving && setMakeLiveItem(null)}>
          <div className="adm-modal adm-modal--form pm-make-live-modal" onClick={(e) => e.stopPropagation()}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Make live</h3>
              <button
                type="button"
                className="adm-modal-close"
                onClick={() => setMakeLiveItem(null)}
                disabled={makeLiveSaving}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <p className="adm-modal-note">
              <strong>{productListTitle(makeLiveItem, 'archived')}</strong>
              {' '}
              — choose the category before moving to the live catalogue.
            </p>
            <div className="adm-modal-body pm-make-live-fields">
              <label className="adm-field">
                <span className="adm-field-label">Main category</span>
                <select
                  value={makeLiveCategory.categoryId}
                  onChange={(e) => {
                    const categoryId = e.target.value;
                    const firstChild = subcategoryOptionsFromTree(tree, categoryId)[0]?.id || '';
                    setMakeLiveCategory({ categoryId, childIds: firstChild ? [firstChild] : [] });
                  }}
                  className="adm-field-input"
                  disabled={makeLiveSaving}
                >
                  <option value="" disabled>— Pick a category —</option>
                  {tree.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              {/*
                Dynamic child pickers — Child 1, Child 2, … as deep as the tree
                goes (no fixed cap), so a product can be made live into a
                subcategory nested past subcategory_four. Each level renders only
                while its parent has a value and options exist; the loop stops one
                level past the deepest selection, offering exactly one more picker.
              */}
              {(() => {
                const childIds = makeLiveCategory.childIds || [];
                const fields = [];
                let parentId = makeLiveCategory.categoryId;
                for (let level = 1; parentId; level += 1) {
                  const rawOptions = level === 1
                    ? subcategoryOptionsFromTree(tree, makeLiveCategory.categoryId)
                    : childrenOfTree(tree, parentId);
                  const currentValue = childIds[level - 1] || '';
                  const options = withCurrentOption(rawOptions, currentValue);
                  if (!options.length) break;
                  fields.push({ level, options, currentValue });
                  parentId = currentValue;
                }
                return fields.map(({ level, options, currentValue }) => (
                  <label className="adm-field" key={level}>
                    <span className="adm-field-label">Child category {level}</span>
                    <select
                      value={currentValue}
                      onChange={(e) => setMakeLiveCategory((prev) => ({
                        ...prev,
                        childIds: [...(prev.childIds || []).slice(0, level - 1), e.target.value].filter(Boolean),
                      }))}
                      className="adm-field-input"
                      disabled={makeLiveSaving}
                    >
                      <option value="">— None —</option>
                      {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                ));
              })()}
            </div>
            <div className="adm-modal-footer adm-modal-footer--end">
              <div className="adm-modal-footer__actions">
                <button type="button" className="adm-btn-ghost" onClick={() => setMakeLiveItem(null)} disabled={makeLiveSaving}>
                  Cancel
                </button>
                <button type="button" className="adm-btn-red" onClick={() => void confirmMakeLive()} disabled={makeLiveSaving}>
                  {makeLiveSaving ? <><Loader2 size={14} className="spin" /> Making live…</> : 'Make live'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
