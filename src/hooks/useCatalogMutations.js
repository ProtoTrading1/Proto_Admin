import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';
import {
  archiveProduct,
  bulkArchiveProducts,
  bulkDeleteForeverProducts,
  bulkRecycleProducts,
  bulkRestoreRecycledProducts,
  bulkUnarchiveProducts,
  deleteProduct,
  recycleProduct,
  restoreRecycledProduct,
} from '../lib/products';

async function stockMutate(body) {
  const res = await fetch('/api/stock-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Action failed');
  return json;
}

function invalidateCatalogAndStats(queryClient, statuses = []) {
  for (const status of statuses) {
    queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'catalog' && q.queryKey[1]?.status === status,
    });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
  // Signal that catalogue membership changed so the sidebar category-count
  // badges (a separate data source from the list) can refresh. Without this,
  // single-row/bulk archive/restore/delete updated the list but left the
  // badges stale until an unrelated taxonomy reload.
  window.dispatchEvent(new CustomEvent('proto-catalog-mutated'));
}

export function useCatalogMutations() {
  const queryClient = useQueryClient();

  const archive = useMutation({
    mutationFn: (sku) => archiveProduct(sku, true),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  const unarchive = useMutation({
    mutationFn: (sku) => archiveProduct(sku, false),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  const softDelete = useMutation({
    mutationFn: (arg) => {
      const sku = typeof arg === 'string' ? arg : arg?.sku;
      const fromArchive = typeof arg === 'object' && arg?.fromArchive;
      return recycleProduct(sku, { fromArchive: !!fromArchive });
    },
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const restoreRecycle = useMutation({
    mutationFn: (sku) => restoreRecycledProduct(sku),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const permanentDelete = useMutation({
    mutationFn: (sku) => deleteProduct(sku),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const setNewArrival = useMutation({
    mutationFn: ({ sku, isNewArrival }) => stockMutate({ action: 'setNewArrival', sku, isNewArrival: !!isNewArrival }),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  const setToOrder = useMutation({
    mutationFn: ({ sku, toOrder }) => stockMutate({ action: 'setToOrder', sku, toOrder: !!toOrder }),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  const setStockAvailable = useMutation({
    mutationFn: ({ sku, stockAvailable }) => stockMutate({
      action: 'setProductAvailability',
      sku,
      incomingStatus: stockAvailable ? 'landed_awaiting_grv' : 'none',
      // This private marker makes the control a simple on/off toggle. The
      // existing GRV reconciliation clears it on the next positive stock move.
      incomingQty: stockAvailable ? 0.001 : 0,
      incomingEta: '',
      shipmentRef: '',
      allowPreorder: false,
    }),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live']),
  });

  const bulkArchive = useMutation({
    mutationFn: (skus) => bulkArchiveProducts(skus),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  // Batched recycle-bin actions: ONE request + ONE invalidation per run.
  const bulkRecycle = useMutation({
    mutationFn: ({ skus, fromArchive = false }) => bulkRecycleProducts(skus, { fromArchive }),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const bulkRestoreRecycle = useMutation({
    mutationFn: (skus) => bulkRestoreRecycledProducts(skus),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const bulkPermanentDelete = useMutation({
    mutationFn: (skus) => bulkDeleteForeverProducts(skus),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived', 'recycle']),
  });

  const bulkUnarchive = useMutation({
    mutationFn: (skus) => bulkUnarchiveProducts(skus),
    onSettled: () => invalidateCatalogAndStats(queryClient, ['live', 'archived']),
  });

  return {
    archive,
    unarchive,
    bulkArchive,
    bulkRecycle,
    bulkRestoreRecycle,
    bulkPermanentDelete,
    bulkUnarchive,
    softDelete,
    restoreRecycle,
    permanentDelete,
    setNewArrival,
    setToOrder,
    setStockAvailable,
  };
}
