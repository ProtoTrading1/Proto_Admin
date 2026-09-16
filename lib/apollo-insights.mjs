// Apollo is a decision layer, not another raw-analytics screen.  It only
// derives messages from the already-labelled reporting sources it receives;
// it never fills gaps with guesses or combines website orders with Positill.

function ratio(numerator, denominator) {
  const a = Number(numerator) || 0;
  const b = Number(denominator) || 0;
  return b > 0 ? a / b : null;
}

function percent(value) {
  return value === null ? null : Math.round(value * 1000) / 10;
}

function hasCompleteEvidence(source) {
  return Boolean(source?.data) && source.status === 'available' && source.complete !== false && source.data.complete !== false;
}

export function buildApolloInsights({ orders, searches, activity, baskets } = {}) {
  const items = [];
  const search = hasCompleteEvidence(searches) ? searches.data : null;
  const order = hasCompleteEvidence(orders) && orders.data.revenueKnown === true && orders.data.revenue != null ? orders.data : null;
  const visits = activity?.data;
  const basket = hasCompleteEvidence(baskets) ? baskets.data : null;

  if (search) {
    const searchToCart = ratio(search.cartAdds, search.recordedSearches);
    const searchToOrder = ratio(search.attributedOrders, search.recordedSearches);
    const zeroDemand = [...(search.topTerms || [])]
      .filter(row => row.zeroResults > 0)
      .sort((a, b) => b.zeroResults - a.zeroResults || b.searches - a.searches || a.term.localeCompare(b.term))[0];
    if (zeroDemand) {
      items.push({
        kind: 'opportunity',
        title: `Search demand gap: ${zeroDemand.term}`,
        detail: `${zeroDemand.zeroResults} recorded no-result search${zeroDemand.zeroResults === 1 ? '' : 'es'} in this period. Review the catalogue, synonyms or buying opportunity.`,
        source: searches.source,
      });
    }
    if (searchToCart !== null || searchToOrder !== null) {
      items.push({
        kind: 'conversion',
        title: 'Search conversion',
        detail: `${search.recordedSearches} searches → ${search.clicks} product clicks → ${search.cartAdds} basket additions → ${search.attributedOrders} attributed website orders${searchToCart === null ? '' : ` (${percent(searchToCart)}% to basket)`}${searchToOrder === null ? '' : ` (${percent(searchToOrder)}% to order)`}.`,
        source: searches.source,
      });
    }
  }

  if (order) {
    items.push({
      kind: 'orders',
      title: 'Website order position',
      detail: `${order.orders} recorded website order${order.orders === 1 ? '' : 's'} worth ${order.revenue} including VAT. This includes all non-cancelled order stages and is not payment-confirmed sales or Positill sales.`,
      source: orders.source,
    });
  }

  const activeCustomers = visits?.activeCustomers;
  const activeSeconds = visits?.activeSeconds;
  const activityCountsValid = Number.isSafeInteger(activeCustomers) && activeCustomers >= 0
    && typeof activeSeconds === 'number' && Number.isFinite(activeSeconds) && activeSeconds >= 0;
  if (visits && activity?.status === 'available' && activity.complete === true && activityCountsValid) {
    items.push({
      kind: 'engagement',
      title: 'Customer attention',
      detail: `${activeCustomers} signed-in customer${activeCustomers === 1 ? '' : 's'} recorded ${activeSeconds} seconds of estimated active browsing.`,
      source: activity.source,
    });
  }

  if (basket && basket.openBaskets > 0) {
    items.push({
      kind: 'basket',
      title: 'Outstanding basket value',
      detail: `${basket.openBaskets} saved basket${basket.openBaskets === 1 ? '' : 's'} hold ${basket.totalUnits} units worth ${basket.valueInclVat} including VAT; ${basket.coldBaskets} ${basket.coldBaskets === 1 ? 'is' : 'are'} inactive for more than 30 days. These are not sales.`,
      source: baskets.source,
    });
  }

  return items;
}

