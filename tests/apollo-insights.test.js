import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { buildApolloInsights } from '../lib/apollo-insights.mjs';

test('joins existing reporting evidence into a business priority without inventing sales', () => {
  const insights = buildApolloInsights({
    orders: { source: 'portal.orders', status: 'available', complete: true, data: { orders: 2, revenue: 200, revenueKnown: true, complete: true } },
    searches: { source: 'portal.search_analytics', status: 'available', complete: true, data: { recordedSearches: 10, clicks: 5, cartAdds: 2, attributedOrders: 1, complete: true,
      topTerms: [{ term: 'diary', searches: 4, zeroResults: 3 }] } },
    activity: { source: 'apollo_activity_events', status: 'available', complete: true, data: { activeCustomers: 1, averageSecondsPerCustomer: 120, activeSeconds: 120 } },
    baskets: { source: 'portal.customer_account_carts', status: 'available', complete: true, data: { openBaskets: 2, totalUnits: 4, valueInclVat: 99, coldBaskets: 1 } },
  });
  assert.equal(insights[0].title, 'Search demand gap: diary');
  assert.match(insights.find(row => row.kind === 'orders').detail, /not payment-confirmed sales or Positill sales/);
  assert.match(insights.find(row => row.kind === 'engagement').detail, /1 signed-in customer recorded 120 seconds of estimated active browsing/);
  assert.doesNotMatch(insights.find(row => row.kind === 'engagement').detail, /undefined/);
  assert.match(insights.find(row => row.kind === 'basket').detail, /not sales/);
});

test('does not turn partial activity intervals into a complete engagement insight', () => {
  const insights = buildApolloInsights({ activity: { source: 'apollo_activity_events', status: 'partial', complete: false,
    data: { customers: 1, activeSeconds: 120 } } });
  assert.deepEqual(insights, []);
});

test('does not generate an engagement insight from stale visit field names or invalid counts', () => {
  for (const data of [
    { customers: 2, recordedVisits: 3, activeSeconds: 60 },
    { activeCustomers: 1, activeSeconds: null },
    { activeCustomers: -1, activeSeconds: 60 },
  ]) {
    const insights = buildApolloInsights({ activity: { source: 'apollo_activity_events', status: 'available', complete: true, data } });
    assert.deepEqual(insights, []);
  }
});

test('does not turn partial or unavailable sales, search or basket data into decision insights', () => {
  const insights = buildApolloInsights({
    orders: { source: 'portal.orders', status: 'partial', complete: false, data: { orders: 5, revenue: 900, revenueKnown: true } },
    searches: { source: 'portal.search_analytics', status: 'available', complete: false, data: { recordedSearches: 20, clicks: 4, cartAdds: 2, attributedOrders: 1,
      topTerms: [{ term: 'beads', searches: 5, zeroResults: 4 }] } },
    baskets: { source: 'portal.customer_account_carts', status: 'unavailable', complete: false, data: { openBaskets: 1, totalUnits: 3, valueInclVat: 40, coldBaskets: 0 } },
  });
  assert.deepEqual(insights, []);
});

test('does not claim a website sales insight when the aggregate does not know revenue', () => {
  const insights = buildApolloInsights({
    orders: { source: 'portal.orders', status: 'available', complete: true, data: { orders: 2, revenue: null, revenueKnown: false } },
  });
  assert.deepEqual(insights, []);
});

test('does not promote a partial payload even if its envelope mistakenly says available', () => {
  const insights = buildApolloInsights({
    searches: { source: 'portal.search_analytics', status: 'available', complete: true, data: { complete: false,
      recordedSearches: 20, clicks: 4, cartAdds: 2, attributedOrders: 1, topTerms: [{ term: 'beads', searches: 5, zeroResults: 4 }] } },
  });
  assert.deepEqual(insights, []);
});

