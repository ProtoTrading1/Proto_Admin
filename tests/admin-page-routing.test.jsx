/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/lib/products', () => ({
  bulkArchiveProducts: vi.fn(), createProduct: vi.fn(), fetchAdminProductsPage: vi.fn(),
  fetchAllProductsAdmin: vi.fn(), fetchCatalogArchiveCount: vi.fn(), fetchDistinctCategories: vi.fn(() => Promise.resolve([])),
  invalidateAdminCache: vi.fn(), invalidateProductCache: vi.fn(), fetchProductAvailability: vi.fn(),
  setLiveTaxonomyTree: vi.fn(), setNewArrival: vi.fn(), setProductAvailability: vi.fn(),
  setToOrder: vi.fn(), updateProduct: vi.fn(), uploadDormantImage: vi.fn(),
}));
vi.mock('../src/lib/imageProcessingHandoff.js', () => ({
  clearPendingNutstoreHandoff: vi.fn(),
  IMAGE_PROCESSING_HANDOFF_KEY: 'ipc-handoff',
  loadImageProcessingIntake: vi.fn(() => ({})),
  loadPendingNutstoreHandoff: vi.fn(() => []),
  saveImageProcessingIntake: vi.fn((options) => options || {}),
  savePendingNutstoreHandoff: vi.fn((rows) => rows || []),
}));
vi.mock('../src/lib/taxonomyAdmin', () => ({
  categoryLabelFromTree: vi.fn(), countSubcategoryProducts: vi.fn(), createCategory: vi.fn(),
  createSubcategory: vi.fn(), deleteTaxonomyNode: vi.fn(), fetchTaxonomy: vi.fn(() => Promise.resolve([])),
  fetchCategoryProductCounts: vi.fn(() => Promise.resolve({})), flattenSubcategories: vi.fn(() => []),
  renameTaxonomyNode: vi.fn(), replaceFullTaxonomy: vi.fn(), subcategoryOptionsFromTree: vi.fn(() => []),
}));
vi.mock('../src/lib/customers', () => ({
  fetchCustomerImportBatches: vi.fn(), approveCustomer: vi.fn(), deleteCustomer: vi.fn(),
  fetchCustomersPage: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  fetchProtoActiveCustomersPage: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  updateProtoActiveCustomer: vi.fn(),
  updateCustomerAdmin: vi.fn(), deleteProtoActiveCustomer: vi.fn(), deleteAllProtoActiveCustomers: vi.fn(),
  importProtoActiveCustomers: vi.fn(), sendCustomerEmailBroadcast: vi.fn(), fetchCrmContactsPage: vi.fn(),
}));
vi.mock('../src/lib/businessTypes', () => ({ BUSINESS_TYPES: [] }));
vi.mock('../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../src/lib/orderDocuments', () => ({
  buildOrderNoteSections: vi.fn(), createEmailOrderItems: vi.fn(), generateOrderPdfBase64: vi.fn(),
  buildEmailItemsFromOrder: vi.fn(), base64ToBlob: vi.fn(), resolveCustomerOrderPricing: vi.fn(),
  deriveAutoNotesFromItems: vi.fn(),
}));
vi.mock('../src/lib/orderNumber', () => ({ displayOrderNumber: vi.fn(), buildFulfillmentUrl: vi.fn() }));
vi.mock('../src/lib/presaleInvoice', () => ({ fetchPresaleInvoices: vi.fn(), uploadPresaleInvoice: vi.fn() }));
vi.mock('../src/lib/orderPayment', () => ({
  fetchConfirmationSent: vi.fn(), markConfirmationSent: vi.fn(), fetchPaymentRecords: vi.fn(),
  uploadPop: vi.fn(), setPaymentStatus: vi.fn(),
}));
vi.mock('../src/lib/orders', () => ({
  deleteOrderAdmin: vi.fn(), fetchOrdersPage: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  updateOrderAdmin: vi.fn(), advanceOrderWorkflow: vi.fn(),
}));
vi.mock('../src/lib/orderTeamWhatsapp', () => ({ fetchTeamWhatsappSent: vi.fn(), sendTeamWhatsapp: vi.fn() }));
vi.mock('../src/lib/orderStatus', () => ({
  orderMatchesTab: vi.fn(() => true),
  normalizeOrderStatus: vi.fn((status) => status || ''),
  getWorkflowAdvanceOptions: vi.fn(() => []),
  isOrderConfirmationSent: vi.fn(() => false),
}));
vi.mock('../src/lib/fulfillmentUsers', () => ({ fetchFulfillmentUsers: vi.fn(() => Promise.resolve([])), loadActiveUserId: vi.fn(() => '') }));
vi.mock('../src/lib/fulfillmentAuth', () => ({ isVictorSender: vi.fn(() => false), CUSTOMER_SEND_FORBIDDEN: '', PAYMENT_RECEIVED_FORBIDDEN: '' }));
vi.mock('../src/lib/apiError', () => ({ errorFromJson: vi.fn() }));
vi.mock('../src/lib/pricing', () => ({ formatWebsitePrice: vi.fn((value) => String(value)) }));
vi.mock('../src/lib/specials', () => ({ fetchSpecials: vi.fn(() => Promise.resolve({ items: [] })), saveSpecials: vi.fn() }));
vi.mock('../src/hooks/useDashboardStats', () => ({ useDashboardStats: () => ({ data: { liveProducts: 0, archivedProducts: 0, customers: 0, orders: 0 } }) }));
vi.mock('../src/lib/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock('../src/lib/queryKeys', () => ({ queryKeys: { dashboardStats: vi.fn(() => ['dashboard']), catalog: vi.fn(() => ['catalog']) } }));
vi.mock('../src/lib/adminRefresh', () => ({ dispatchAdminRefresh: vi.fn() }));
vi.mock('../src/lib/lazyRetry', () => ({
  lazyRetry: (loader) => React.lazy(loader),
}));
vi.mock('../src/data/categories.json', () => ({ default: [] }));

vi.mock('../src/components/ProductManagerEngine', () => ({ default: ({ title = 'Product Manager' }) => <div>{title}</div> }));
vi.mock('../src/components/ProductLoaderPanel', () => ({
  default: ({ initialTab }) => <div>{initialTab === 'image-processing' ? 'Image Processing Centre mounted' : 'Product Loader mounted'}</div>,
}));
vi.mock('../src/components/GroupedSidebar', () => ({
  NAV_GROUPS: [
    { id: 'orders', label: 'Order Requests' },
    { id: 'product-loader', label: 'Product Loader' },
    { id: 'image-processing', label: 'Image Processing Centre' },
    { id: 'catalogue', label: 'Product Manager' },
    { id: 'team', label: 'Team' },
  ],
  default: ({ allowedSectionIds = [], onSelectSection }) => (
    <nav>
      {allowedSectionIds.map((id) => <button key={id} type="button" onClick={() => onSelectSection(id)}>{id}</button>)}
    </nav>
  ),
}));

const MockPanel = ({ children, title, label }) => <div>{children || title || label || null}</div>;

vi.mock('../src/components/OrderWorkflowBadge', () => ({ default: MockPanel }));
vi.mock('../src/components/TaxonomyModals', () => ({ default: MockPanel }));
vi.mock('../src/components/SectionErrorBoundary', () => ({ default: MockPanel }));
vi.mock('../src/components/PlacementsEditor', () => ({ default: MockPanel }));
vi.mock('../src/components/AdminSelect', () => ({ default: MockPanel }));
vi.mock('../src/components/ComingSoonPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/OrderEmailNotify', () => ({ default: MockPanel }));
vi.mock('../src/components/SellingUnitField', () => ({ default: MockPanel }));
vi.mock('../src/components/CustomerIntelligenceWorkspace', () => ({ default: MockPanel }));
vi.mock('../src/components/AddCustomerModal', () => ({ default: MockPanel }));
vi.mock('../src/components/ActionMenu', () => ({ default: MockPanel }));
vi.mock('../src/components/BridgeStatusDot', () => ({ default: MockPanel }));
vi.mock('../src/components/LiveShoppersDot', () => ({ default: MockPanel }));
vi.mock('../src/components/FulfillmentSettingsModal', () => ({ default: MockPanel }));
vi.mock('../src/components/AnalyticsHub', () => ({ default: MockPanel }));
vi.mock('../src/components/BulkImageReplacePanel', () => ({ default: MockPanel }));
vi.mock('../src/components/BannerPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/FeaturedPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/SpecialsPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/PricingPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/ReorderPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/OrdersWorkspacePanel', () => ({ default: MockPanel }));
vi.mock('../src/components/BackendHealthPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/HermesPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/ProductIntelligencePanel', () => ({ default: MockPanel }));
vi.mock('../src/components/BuyingPanel', () => ({ default: MockPanel }));
vi.mock('../src/components/CustomerEmailModal', () => ({ default: MockPanel }));
vi.mock('../src/components/CommsPanel', () => ({ default: MockPanel }));

describe('AdminPage mounted section routing', () => {
  let root;
  let container;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.React = React;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    root = null;
    container.remove();
    document.body.innerHTML = '';
    delete globalThis.React;
    vi.useRealTimers();
  });

  async function renderAt(search, customer = { id: '1', name: 'Owner', email: 'owner@example.test', role: 'owner' }) {
    window.history.replaceState({}, '', `/${search}`);
    const { default: AdminPage } = await import('../src/pages/AdminPage.jsx');
    root = createRoot(container);
    await act(async () => {
      root.render(<AdminPage customer={customer} onViewPortal={() => {}} onSignOut={() => {}} />);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
  }

  it('renders Image Processing Centre from the view alias and normalizes the URL', async () => {
    await renderAt('?view=image-processing');
    expect(document.body.textContent).toContain('Image Processing Centre mounted');
    expect(window.location.search).toBe('?section=image-processing');
  });

  it('keeps restricted users out of Image Processing Centre deep links', async () => {
    await renderAt('?section=image-processing', { id: '2', name: 'CS', email: 'cs@example.test', role: 'customer_service' });
    expect(document.body.textContent).not.toContain('Image Processing Centre mounted');
    expect(window.location.search).toBe('?section=orders');
  });
});
