import { Suspense, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { lazyRetry } from '../lib/lazyRetry';

const OrderAnalyticsDashboard = lazyRetry(() => import('./OrderAnalyticsDashboard'));
const SearchAnalyticsDashboard = lazyRetry(() => import('./SearchAnalyticsDashboard'));
const AbandonedBasketsPanel = lazyRetry(() => import('./AbandonedBasketsPanel'));
const EngagementPanel = lazyRetry(() => import('./EngagementPanel'));

const VIEWS = [
  { key: 'orders', label: 'Order Analytics', Component: OrderAnalyticsDashboard },
  { key: 'search', label: 'Search Analytics', Component: SearchAnalyticsDashboard },
  { key: 'baskets', label: 'Abandoned Baskets', Component: AbandonedBasketsPanel },
  { key: 'engagement', label: 'Engagement', Component: EngagementPanel },
];

export default function AnalyticsHub() {
  const [view, setView] = useState('orders');
  const Active = (VIEWS.find((item) => item.key === view) || VIEWS[0]).Component;

  return (
    <div className="oa-hub">
      <div className="adm-customer-tabs oa-hub-tabs">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setView(item.key)}
            className={`adm-tab${view === item.key ? ' adm-tab--active' : ''}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/*
        Each view is its own lazy chunk, so switching tabs swaps a ~1000px
        dashboard for a ~100px spinner. The page height collapsed and the
        scroll position lurched — the "it drops down when I switch" bug. The
        wrapper holds the height steady across the swap.
      */}
      <div className="oa-hub-view">
        <Suspense fallback={(
          <div className="oa-loading oa-loading--reserved">
            <Loader2 size={20} className="spin" />
            <span>Loading analytics…</span>
          </div>
        )}
        >
          <Active />
        </Suspense>
      </div>
    </div>
  );
}
