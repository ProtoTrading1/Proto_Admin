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

export function buildApolloInsights({ orders, searches, activity, baskets } = {}) {
  const items = [];
  const search = searches?.data;
  const order = orders?.data;
  const visits = activity?.data;
  const basket = baskets?.data;

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
      kind: 'sales',
      title: 'Website order position',
      detail: `${order.orders} recorded website order${order.orders === 1 ? '' : 's'} worth ${order.revenue} including VAT. This is website order value, not Positill sales.`,
      source: orders.source,
    });
  }

  if (visits) {
    items.push({
      kind: 'engagement',
      title: 'Customer attention',
      detail: `${visits.customers} signed-in customer${visits.customers === 1 ? '' : 's'} recorded ${visits.recordedVisits} visit${visits.recordedVisits === 1 ? '' : 's'} and ${visits.activeSeconds} seconds of recorded browsing.`,
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
