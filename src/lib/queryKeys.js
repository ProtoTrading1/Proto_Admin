/** TanStack Query key factory — keeps cache keys consistent across hooks. */

export const queryKeys = {
  dashboardStats: () => ['dashboard-stats'],
  taxonomy: () => ['taxonomy'],
  catalog: (params) => ['catalog', params],
  crmContacts: (params) => ['crm-contacts', params],
  sortOrder: (categoryKey) => ['sort-order', categoryKey],
  banner: () => ['banner'],
  specials: () => ['specials'],
  featuredProducts: () => ['featured-products'],
  orders: (params) => ['orders', params],
  customers: (params) => ['customers', params],
};
