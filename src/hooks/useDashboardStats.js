import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys';

async function fetchDashboardStats({ refresh = false } = {}) {
  const url = refresh ? '/api/dashboard-stats?refresh=1' : '/api/dashboard-stats';
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load stats');
  return json;
}

export function useDashboardStats() {
  return useQuery({
    queryKey: queryKeys.dashboardStats(),
    // Do NOT force refresh=1 here — that bypassed the server's 60s cache, the
    // in-flight de-dupe AND the edge cache on every single dashboard open,
    // running a full archived_products + website_stock scan each time. Serve
    // the cached stats; an explicit Refresh (invalidate) still refetches.
    queryFn: () => fetchDashboardStats({ refresh: false }),
    staleTime: 2 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: 3000,
  });
}
