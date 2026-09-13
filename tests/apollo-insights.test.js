import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { buildApolloInsights } from '../lib/apollo-insights.mjs';

test('joins existing reporting evidence into a business priority without inventing sales', () => {
  const insights = buildApolloInsights({
    orders: { source: 'portal.orders', data: { orders: 2, revenue: 200 } },
    searches: { source: 'portal.search_analytics', data: { recordedSearches: 10, clicks: 5, cartAdds: 2, attributedOrders: 1,
      topTerms: [{ term: 'diary', searches: 4, zeroResults: 3 }] } },
    activity: { source: 'portal.customer_visits', data: { customers: 1, recordedVisits: 2, activeSeconds: 120 } },
    baskets: { source: 'portal.customer_account_carts', data: { openBaskets: 2, totalUnits: 4, valueInclVat: 99, coldBaskets: 1 } },
  });
  assert.equal(insights[0].title, 'Search demand gap: diary');
  assert.match(insights.find(row => row.kind === 'sales').detail, /not Positill sales/);
  assert.match(insights.find(row => row.kind === 'engagement').detail, /120 seconds/);
  assert.match(insights.find(row => row.kind === 'basket').detail, /not sales/);
});
