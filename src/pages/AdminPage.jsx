import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  Bot,
  MessageCircle,
  Building2,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  DollarSign,
  Download,
  Eye,
  FileDown,
  Home,
  Plus,
  Globe,
  Grip,
  Image,
  ImagePlus,
  Layout,
  Loader2,
  Lock,
  Megaphone,
  Upload,
  Mail,
  MapPin,
  Menu,
  PackagePlus,
  PauseCircle,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Star,
  Store,
  Trash2,
  TrendingUp,
  User,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react';
// xlsx is loaded on demand in the export handlers — keeps it out of the main bundle
import {
  bulkArchiveProducts,
  createProduct,
  fetchAdminProductsPage,
  fetchAllProductsAdmin,
  fetchCatalogArchiveCount,
  fetchDistinctCategories,
  invalidateAdminCache,
  invalidateProductCache,
  fetchProductAvailability,
  setLiveTaxonomyTree,
  setNewArrival,
  setProductAvailability,
  setToOrder,
  updateProduct,
  uploadDormantImage,
} from '../lib/products';
import {
  clearPendingNutstoreHandoff,
  IMAGE_PROCESSING_HANDOFF_KEY,
  loadImageProcessingIntake,
  loadPendingNutstoreHandoff,
  saveImageProcessingIntake,
  savePendingNutstoreHandoff,
} from '../lib/imageProcessingHandoff.js';
import {
  categoryLabelFromTree,
  countSubcategoryProducts,
  createCategory,
  createSubcategory,
  deleteTaxonomyNode,
  fetchTaxonomy,
  fetchCategoryProductCounts,
  flattenSubcategories,
  renameTaxonomyNode,
  replaceFullTaxonomy,
  subcategoryOptionsFromTree,
} from '../lib/taxonomyAdmin';
import { fetchCustomerImportBatches, approveCustomer, deleteCustomer, fetchCustomersPage, fetchProtoActiveCustomersPage, updateProtoActiveCustomer, updateCustomerAdmin, deleteProtoActiveCustomer, deleteAllProtoActiveCustomers, importProtoActiveCustomers, sendCustomerEmailBroadcast, fetchCrmContactsPage } from '../lib/customers';
import { BUSINESS_TYPES } from '../lib/businessTypes';
import { supabase } from '../lib/supabase';
import { buildOrderNoteSections, createEmailOrderItems, generateOrderPdfBase64, buildEmailItemsFromOrder, base64ToBlob, resolveCustomerOrderPricing, deriveAutoNotesFromItems } from '../lib/orderDocuments';
import { displayOrderNumber, buildFulfillmentUrl } from '../lib/orderNumber';
import { fetchPresaleInvoices, uploadPresaleInvoice } from '../lib/presaleInvoice';
import { fetchConfirmationSent, markConfirmationSent, fetchPaymentRecords, uploadPop, setPaymentStatus } from '../lib/orderPayment';
import { deleteOrderAdmin, fetchOrdersPage, updateOrderAdmin, advanceOrderWorkflow } from '../lib/orders';
import { fetchTeamWhatsappSent, sendTeamWhatsapp as sendTeamWhatsappApi } from '../lib/orderTeamWhatsapp';
import { orderMatchesTab, normalizeOrderStatus, getWorkflowAdvanceOptions, isOrderConfirmationSent } from '../lib/orderStatus';
import OrderWorkflowBadge from '../components/OrderWorkflowBadge';
import { fetchFulfillmentUsers, loadActiveUserId } from '../lib/fulfillmentUsers';
import { isVictorSender, CUSTOMER_SEND_FORBIDDEN, PAYMENT_RECEIVED_FORBIDDEN } from '../lib/fulfillmentAuth';
import { errorFromJson } from '../lib/apiError';
import { formatWebsitePrice } from '../lib/pricing';
import { fetchSpecials, saveSpecials } from '../lib/specials';
import {
  adminSectionUrl,
  initialAdminSectionFromSearch,
  normalizeRequestedAdminSection,
} from '../lib/adminSectionRoute';
import TaxonomyModals from '../components/TaxonomyModals';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import PlacementsEditor from '../components/PlacementsEditor';
import AdminSelect from '../components/AdminSelect';
import ComingSoonPanel from '../components/ComingSoonPanel';
import OrderEmailNotify from '../components/OrderEmailNotify';
import NotificationQueueHealth from '../components/NotificationQueueHealth';
import ProductManagerEngine from '../components/ProductManagerEngine';
import GroupedSidebar, { NAV_GROUPS } from '../components/GroupedSidebar';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { queryClient } from '../lib/queryClient';
import { queryKeys } from '../lib/queryKeys';
import { dispatchAdminRefresh } from '../lib/adminRefresh';
import { lazyRetry } from '../lib/lazyRetry';
import SellingUnitField from '../components/SellingUnitField';
import CustomerIntelligenceWorkspace from '../components/CustomerIntelligenceWorkspace';
import { POSITILL_CUSTOMER_SALES_PERIOD } from '../lib/customerIq';

// Section panels — lazy-loaded so the initial admin bundle only ships the
// default section (Product Manager). Each lazy chunk is fetched on demand
// when the admin clicks a nav item.
const AnalyticsHub = lazyRetry(() => import('../components/AnalyticsHub'));
const ProductLoaderPanel = lazyRetry(() => import('../components/ProductLoaderPanel'));
const BulkImageReplacePanel = lazyRetry(() => import('../components/BulkImageReplacePanel'));
const BannerPanel = lazyRetry(() => import('../components/BannerPanel'));
const FeaturedPanel = lazyRetry(() => import('../components/FeaturedPanel'));
const SpecialsPanel = lazyRetry(() => import('../components/SpecialsPanel'));
const PricingPanel = lazyRetry(() => import('../components/PricingPanel'));
const ReorderPanel = lazyRetry(() => import('../components/ReorderPanel'));
const OrdersWorkspacePanel = lazyRetry(() => import('../components/OrdersWorkspacePanel'));
const BackendHealthPanel = lazyRetry(() => import('../components/BackendHealthPanel'));
const HermesPanel = lazyRetry(() => import('../components/HermesPanel'));
const ProductIntelligencePanel = lazyRetry(() => import('../components/ProductIntelligencePanel'));
const BuyingPanel = lazyRetry(() => import('../components/BuyingPanel'));

function orderWorkspaceIdFromPath() {
  const match = window.location.pathname.match(/^\/(?:apollo\/)?orders\/workspace\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function SectionSuspenseFallback({ label = 'Loading…' }) {
  return (
    <div className="adm-panel" style={{ padding: 24, color: '#64748b' }} role="status" aria-live="polite">
      {label}
    </div>
  );
}

// Modal-only — chunk downloads the first time the admin opens the dialog.
const CustomerEmailModal = lazyRetry(() => import('../components/CustomerEmailModal'));
const CommsPanel = lazyRetry(() => import('../components/CommsPanel'));
// AddCustomerModal is tiny and eager (not lazy) so opening it can never hit a
// stale-chunk load failure — which the recovery would resolve by reloading the
// whole page (reads as "the button just refreshes").
import AddCustomerModal from '../components/AddCustomerModal';
import ActionMenu from '../components/ActionMenu';
import BridgeStatusDot from '../components/BridgeStatusDot';
import LiveShoppersDot from '../components/LiveShoppersDot';
const FulfillmentSettingsModal = lazyRetry(() => import('../components/FulfillmentSettingsModal'));
import categories from '../data/categories.json';

// Legacy flat nav removed — see GroupedSidebar.jsx

function LazySectionFallback({ label = 'Loading section…' }) {
  return (
    <div
      className="adm-panel"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: '#64748b' }}
      role="status"
      aria-live="polite"
    >
      <Loader2 size={16} className="spin" /> {label}
    </div>
  );
}

const COMPACT_CUSTOMER_ROWS = 8;

const ORDER_TAB_DEFS = [
  { key: 'new', label: 'New' },
  { key: 'handed', label: 'Handed Over' },
  { key: 'progress', label: 'In Progress' },
  { key: 'sent', label: 'Order Confirmation' },
  { key: 'paid', label: 'Payment' },
  { key: 'all', label: 'All orders', overview: true },
];
const ORDER_TAB_LABELS = Object.fromEntries(ORDER_TAB_DEFS.map((t) => [t.key, t.label]));

const ADMIN_PAGE_SIZE = 50;
/** Order Requests pages small by default — the tabs are a working queue, not an archive. */
const ORDER_PAGE_SIZES = [10, 25, 50, 100];
const ORDER_PAGE_SIZE_DEFAULT = 10;
const CUSTOMER_SERVICE_SECTIONS = ['orders', 'customers', 'comms'];
const OWNER_ONLY_SECTIONS = new Set(['image-processing', 'title-replace']);

function replaceAdminSectionUrl(section) {
  const nextUrl = adminSectionUrl({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    section,
  });
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) window.history.replaceState({}, '', nextUrl);
}

function sectionsForAdminRole(role) {
  if (role === 'customer_service') return CUSTOMER_SERVICE_SECTIONS;
  const allSections = NAV_GROUPS.map((item) => item.id);
  return role === 'owner'
    ? allSections
    : allSections.filter((section) => !OWNER_ONLY_SECTIONS.has(section));
}
const randFormatter = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2, maximumFractionDigits: 4 });

function formatRandAmount(value) {
  const amount = Number(value || 0);
  return randFormatter.format(amount);
}

function orderAmountExVat(order) {
  const total = Number(order?.total_ex_vat);
  if (Number.isFinite(total) && total > 0) return total;
  const items = (order?.final_items?.length ? order.final_items : null)
    || order?.original_items || order?.items || [];
  let sum = 0;
  for (const item of items) {
    const qty = Number(item?.qty ?? item?.quantity ?? 0);
    const price = Number(item?.unitPrice ?? item?.price ?? 0);
    if (Number.isFinite(qty) && Number.isFinite(price)) sum += qty * price;
  }
  return sum;
}

// Promo/discount the customer applied at checkout (migration 028 columns on the
// order row). Returns null when no code was used.
function orderPromo(order) {
  const code = String(order?.promo_code || '').trim();
  if (!code) return null;
  const discountPct = Number(order?.discount_pct);
  const discountAmount = Number(order?.discount_amount);
  return {
    code,
    discountPct: Number.isFinite(discountPct) ? discountPct : null,
    discountAmount: Number.isFinite(discountAmount) ? discountAmount : null,
  };
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelativeDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatJoinStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'Pending';
  if (raw === 'joined') return 'Joined';
  if (raw === 'not joined' || raw === 'no thanks') return 'No thanks';
  return raw.replace(/(^|\s)\w/g, (m) => m.toUpperCase());
}

function renderNoteSections(noteSections) {
  if (!noteSections.length) return <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>No notes yet</span>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {noteSections.map((section) => (
        <div key={section.title} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{section.title}</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {section.lines.map((line, index) => (
              <div key={`${section.title}-${index}`} style={{ fontSize: 13, color: '#374151', lineHeight: 1.55, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: '#16a34a', fontWeight: 700 }}>•</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const PRODUCT_IMAGE_SLOTS = [
  { key: 'image', label: 'Image 1 (primary)' },
  { key: 'secondaryImage', label: 'Image 2' },
  { key: 'imageThree', label: 'Image 3' },
  { key: 'imageFour', label: 'Image 4' },
];

// The product edit form mirrors the four taxonomy levels stored in the DB
// (category, subcategory_one … subcategory_four). Every `child*Id` is a slug
// `child*Id` is a slug from the taxonomy tree at that level — empty string
// means "no value at this level". Saving collapses these into the
// `categoryPath` array, which the API maps back to the DB columns.
const emptyForm = {
  code: '',
  name: '',
  description: '',
  packDescription: '',
  unitsOfIssue: 'EACH',
  minQty: '1',
  image: '',
  secondaryImage: '',
  imageThree: '',
  imageFour: '',
  price: '0',
  stockOnHand: '1',
  isNewArrival: false,
  toOrder: false,
  availabilityLoading: false,
  availabilitySchemaReady: null,
  incomingStatus: 'none',
  incomingQty: '',
  incomingEta: '',
  shipmentRef: '',
  allowPreorder: false,
  categoryId: categories[0]?.id || '',
  childIds: categories[0]?.children?.[0]?.id ? [categories[0].children[0].id] : [],
};

function categoryLabel(id, tree = categories) {
  return categoryLabelFromTree(tree, id);
}

function subcategoryOptions(categoryId, tree = categories) {
  return subcategoryOptionsFromTree(tree, categoryId);
}

/** Return array of ancestor IDs from root down to (but not including) targetId. */
function findNodePath(tree, targetId, path = []) {
  for (const node of (tree || [])) {
    if (node.id === targetId) return path;
    if (node.children?.length) {
      const found = findNodePath(node.children, targetId, [...path, node.id]);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Look up the children of a node by id within an arbitrary tree. */
function childrenOf(tree, id) {
  if (!id) return [];
  const stack = [...(tree || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.id === id) return node.children || [];
    if (node.children?.length) stack.push(...node.children);
  }
  return [];
}

/**
 * If `currentId` is set but not in `options`, prepend a synthetic entry so
 * the user can still see (and replace) a value that no longer maps to a
 * live taxonomy node — e.g. a subcategory that was renamed or deleted.
 */
function withCurrentOption(options, currentId) {
  if (!currentId || options.some((o) => o.id === currentId)) return options;
  return [{ id: currentId, label: `${currentId} (missing)` }, ...options];
}

/** Build the form's category state from a saved product's categoryPath. */
function categoryFormFromPath(categoryPath = [], tree = categories) {
  const categoryId = categoryPath[0] || tree[0]?.id || '';
  return {
    categoryId,
    childIds: categoryPath.slice(1).filter(Boolean),
  };
}

/** Gold pill for pre-registered CSV customers who signed up (auto-approved, code allocated manually). */
function TenThousandClubBadge({ customer }) {
  if (!customer?.tags?.includes?.('10000 club')) return null;
  return (
    <span
      title="Pre-registered customer — auto-approved at signup. Allocate their customer code manually."
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.4,
        color: '#92400e',
        background: '#fef3c7',
        border: '1px solid #f59e0b',
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      10000 CLUB
    </span>
  );
}

const LAST_EMAIL_LABELS = {
  welcome: 'Welcome sent',
  campaign: 'Campaign sent',
  order_confirmation: 'Order confirmation sent',
  trade_application: 'Application ack sent',
};

function relativeSince(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Small pill showing the last email sent to a customer + when. */
function LastEmailBadge({ customer }) {
  const type = customer?.last_email_type;
  if (!type) return null;
  const label = LAST_EMAIL_LABELS[type] || 'Email sent';
  const when = relativeSince(customer?.last_email_at);
  return (
    <span
      title={`Last email: ${label}${customer?.last_email_at ? ` (${new Date(customer.last_email_at).toLocaleString()})` : ''}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#1e40af',
        background: '#dbeafe',
        border: '1px solid #93c5fd',
        borderRadius: 4,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      ✉ {label}{when ? ` · ${when}` : ''}
    </span>
  );
}

function compactItems(items = []) {
  return items.map((item) => `${item.code}${item.name ? ` ${item.name}` : ''} × ${item.qty}`).join(', ');
}

function csvDownload(rows, filename) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map((row) => headers.map((key) => JSON.stringify(row[key] ?? '')).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatStockUnits(qty) {
  const n = qty === null || qty === undefined ? 0 : Number(qty);
  return `${Number.isFinite(n) ? n : 0} units`;
}

function productToForm(product, tree = categories) {
  return {
    code: product.code || '',
    name: product.name || '',
    description: product.description || '',
    packDescription: product.packDescription || '',
    unitsOfIssue: product.unitsOfIssue || 'EACH',
    minQty: String(Math.max(1, Math.floor(Number(product.minQty) || 1))),
    image: product.image || product.images?.[0] || '',
    secondaryImage: product.secondaryImage || product.images?.[1] || '',
    imageThree: product.imageThree || product.images?.[2] || '',
    imageFour: product.imageFour || product.images?.[3] || '',
    price: String(product.price ?? 0),
    stockOnHand: product.stockOnHand != null ? String(product.stockOnHand) : '',
    isNewArrival: !!product.isNew,
    toOrder: !!product.toOrder,
    availabilityLoading: false,
    availabilitySchemaReady: null,
    incomingStatus: 'none',
    incomingQty: '',
    incomingEta: '',
    shipmentRef: '',
    allowPreorder: false,
    ...categoryFormFromPath(product.categoryPath, tree),
  };
}

function WhatsappOptIn({ value }) {
  if (value == null) return <span className="adm-muted">—</span>;
  return value
    ? <Check size={16} color="#15803d" strokeWidth={3} aria-label="WhatsApp yes" />
    : <X size={16} color="#dc2626" strokeWidth={3} aria-label="WhatsApp no" />;
}

export default function AdminPage({ customer, onViewPortal, onSignOut }) {
  const initialOrderWorkspaceId = useMemo(() => orderWorkspaceIdFromPath(), []);
  const allowedSectionIds = useMemo(() => sectionsForAdminRole(customer?.role), [customer?.role]);
  const [activeSection, setActiveSection] = useState(() => {
    return initialAdminSectionFromSearch({
      search: window.location.search,
      allowedSectionIds,
      hasOrderWorkspace: Boolean(initialOrderWorkspaceId),
    });
  });
  const [productLoaderCode, setProductLoaderCode] = useState('');
  const [imageProcessingHandoff, setImageProcessingHandoff] = useState(() => ({
    nutstoreSelection: loadPendingNutstoreHandoff(),
    uploadSelection: [],
  }));
  const [imageProcessingIntake, setImageProcessingIntake] = useState(() => loadImageProcessingIntake());
  const [productManagerSearch, setProductManagerSearch] = useState('');
  const [siteContentTab, setSiteContentTab] = useState('featured');
  const { data: dashStats } = useDashboardStats();
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(null);
  const [loadingError, setLoadingError] = useState('');
  const [liveCategories, setLiveCategories] = useState([]);
  const [saving, setSaving] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState(emptyForm);
  const [editorError, setEditorError] = useState('');
  const [editorImageUploading, setEditorImageUploading] = useState(false);
  const [editorImageDragOver, setEditorImageDragOver] = useState('');
  const editorImageFileInputRefs = useRef({});
  const [profileCustomer, setProfileCustomer] = useState(null);
  const [profileOrders, setProfileOrders] = useState([]);
  const [profileOrdersTotal, setProfileOrdersTotal] = useState(0);
  const [profileOrdersLoading, setProfileOrdersLoading] = useState(false);
  const [profileOrdersError, setProfileOrdersError] = useState('');
  const profileOrdersReqSeqRef = useRef(0);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileForm, setProfileForm] = useState({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [contentEditProduct, setContentEditProduct] = useState(null);
  const [contentEditForm, setContentEditForm] = useState({ image: '', description: '', packDescription: '', unitsOfIssue: 'EACH', code: '' });
  const [contentEditSaving, setContentEditSaving] = useState(false);
  const [contentEditError, setContentEditError] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const imageFileInputRef = useRef(null);

  const [imageViewUrl, setImageViewUrl] = useState('');
  const reorderPanelRef = useRef(null);

  const [catalogTotal, setCatalogTotal] = useState(0);
  const [archiveCatalogTotal, setArchiveCatalogTotal] = useState(0);
  const [statsCustomerTotal, setStatsCustomerTotal] = useState(0);
  const [statsOrderTotal, setStatsOrderTotal] = useState(0);

  const [customerTab, setCustomerTab] = useState('regular');
  const [customerSearch, setCustomerSearch] = useState('');
  // Which CSV upload to show in Pre-registration. '' = every contact.
  const [customerBatch, setCustomerBatch] = useState('');
  const [customerBatches, setCustomerBatches] = useState([]);
  // Upload groups for the Pre-registration filter. Read from the admin-guarded
  // endpoint rather than the owner-only customer list, so a non-owner admin
  // still gets the picker.
  useEffect(() => {
    if (activeSection !== 'customers' || customerTab !== 'proto-active') return undefined;
    let alive = true;
    void fetchCustomerImportBatches()
      .then((list) => { if (alive) setCustomerBatches(list || []); })
      .catch(() => { /* the filter is a convenience — never block the list */ });
    return () => { alive = false; };
  }, [activeSection, customerTab]);

  const [customerSearchDebounced, setCustomerSearchDebounced] = useState('');
  const [customerBusinessType, setCustomerBusinessType] = useState('');
  const [customerPage, setCustomerPage] = useState(1);
  const [customerRows, setCustomerRows] = useState([]);
  const [customerTotal, setCustomerTotal] = useState(0);
  // Compact by default: the section opens showing a handful of rows per tab
  // rather than every approved customer / trade request at once.
  const [customerListExpanded, setCustomerListExpanded] = useState(false);
  const customersReqSeqRef = useRef(0);
  const customersCacheRef = useRef(new Map());
  const customersCacheKeyRef = useRef('');
  const [customerEmailOpen, setCustomerEmailOpen] = useState(false);
  const [composeTarget, setComposeTarget] = useState(null);
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  const [profileSource, setProfileSource] = useState('portal');
  const [approvalCodes, setApprovalCodes] = useState({});
  const [protoNameSaving, setProtoNameSaving] = useState(null);

  // Pricing state now lives in PricingPanel.

  const [taxonomyTree, setTaxonomyTree] = useState(categories);
  const [toast, setToast] = useState(null);
  const [editTaxonomyModal, setEditTaxonomyModal] = useState(null);
  const [newSubModal, setNewSubModal] = useState(null);
  const [newCategoryModal, setNewCategoryModal] = useState(null);
  const [deleteSubModal, setDeleteSubModal] = useState(null);
  const [taxonomySaving, setTaxonomySaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [newOrdersCount, setNewOrdersCount] = useState(0);
  const [expandedOrderId, setExpandedOrderId] = useState(null);
  // The order the admin has open, kept renderable after a list refresh drops
  // it from the current tab (see the pinning effects near loadOrders).
  const [pinnedOrder, setPinnedOrder] = useState(null);
  const lastExpandedRowRef = useRef(null);
  const pinToastForRef = useRef(null);
  // Order Workspace now lives below the order list, revealed on demand. Auto-open
  // when a workspace was deep-linked so the URL still lands on it.
  const [orderWorkspaceOpen, setOrderWorkspaceOpen] = useState(Boolean(initialOrderWorkspaceId));

  const [fulfillmentOrder, setFulfillmentOrder] = useState(null);
  const [fulfillmentItems, setFulfillmentItems] = useState([]);
  const [fulfillmentNotes, setFulfillmentNotes] = useState('');
  const [fulfillmentSaving, setFulfillmentSaving] = useState(false);
  const [editingItemIdx, setEditingItemIdx] = useState(null);
  const [productSwapSearch, setProductSwapSearch] = useState('');
  const [productSwapResults, setProductSwapResults] = useState([]);
  const [productSwapLoading, setProductSwapLoading] = useState(false);
  const swapSearchTimerRef = useRef(null);

  const [orders, setOrders] = useState([]);
  const ordersReqSeqRef = useRef(0);
  // What is actually painted right now. loadOrders runs from a 30s timer
  // and a focus handler, whose closures capture whatever `orders` was when
  // they were created — reading the state variable there is unreliable.
  const paintedOrdersRef = useRef([]);
  const ordersCacheRef = useRef(new Map());
  const ordersCacheKeyRef = useRef('');
  const orderTabCountsSigRef = useRef('');
  // The sidebar badge behaves like a notification: opening Order Requests
  // marks the current count as SEEN (persisted), and the badge only returns
  // when the count rises above what was seen.
  const [ordersBadgeSeen, setOrdersBadgeSeen] = useState(() => {
    const stored = Number(localStorage.getItem('adm-orders-badge-seen'));
    return Number.isFinite(stored) ? stored : 0;
  });
  const [orderTab, setOrderTab] = useState('new');
  const [orderPage, setOrderPage] = useState(1);
  const [orderPageSize, setOrderPageSize] = useState(() => {
    const stored = Number(localStorage.getItem('adm-orders-page-size'));
    return ORDER_PAGE_SIZES.includes(stored) ? stored : ORDER_PAGE_SIZE_DEFAULT;
  });
  const [orderTotal, setOrderTotal] = useState(0);
  /**
   * Which request the rows on screen belong to. The `loading` flag below is
   * shared by every section, so another section finishing its own load used to
   * flip it false while orders were still in flight — and "No orders in this
   * tab" would win for a few seconds. Comparing keys instead makes the
   * pending state a property of the orders request itself.
   */
  const [ordersLoadedKey, setOrdersLoadedKey] = useState('');
  const [orderTabCounts, setOrderTabCounts] = useState(null);
  const [orderTrashEnabled, setOrderTrashEnabled] = useState(false);
  const [orderSearchDebounced, setOrderSearchDebounced] = useState('');
  const [focusOrderId, setFocusOrderId] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [fulfillmentSettingsOpen, setFulfillmentSettingsOpen] = useState(false);
  const [fulfillmentUsers, setFulfillmentUsers] = useState([]);
  const [activeFulfillmentUserId, setActiveFulfillmentUserId] = useState(loadActiveUserId);
  const [presaleInvoices, setPresaleInvoices] = useState({});
  const [presaleUploading, setPresaleUploading] = useState('');
  const [confirmationSent, setConfirmationSent] = useState({});
  // "Team notified on WhatsApp" per order. Server-held (site-config), so the
  // tag is the same for every admin and survives a refresh.
  const [teamWaSent, setTeamWaSent] = useState({});
  const [paymentRecords, setPaymentRecords] = useState({});
  const [popUploading, setPopUploading] = useState('');

  // Weekly featured specials — state stays in AdminPage so the Product
  // Manager star toggle can add/remove without cross-tab coupling. The
  // Specials tab reads/writes via SpecialsPanel (see props below).
  const [specials, setSpecials] = useState([]);
  const [specialsSaving, setSpecialsSaving] = useState(false);




  const [categoryProductCounts, setCategoryProductCounts] = useState({});

  const mainCategories = useMemo(
    () => taxonomyTree.map((item) => ({ id: item.id, label: item.label })),
    [taxonomyTree],
  );
  const firstMainCategoryId = mainCategories[0]?.id || '';

  useEffect(() => {
    fetchDistinctCategories().then(setLiveCategories).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setCustomerSearchDebounced(customerSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);
  useEffect(() => { setCustomerPage(1); }, [customerBatch, customerTab, customerSearchDebounced, customerBusinessType]);
  useEffect(() => {
    const timer = setTimeout(() => setOrderSearchDebounced(orderSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [orderSearch]);
  useEffect(() => { setOrderPage(1); }, [orderTab, orderPageSize, orderSearchDebounced]);
  // Banner + Specials own their own load effects — see BannerPanel and SpecialsPanel.


  const refreshDashboardStats = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
  };


  // Tabs backed by their own panels (analytics, scheduled) are not customer
  // lists — never query the customers endpoint for them.
  const CUSTOMER_LIST_TABS = new Set(['requests', 'on-hold', 'regular', 'proto-active']);

  const loadCustomers = async () => {
    if (!CUSTOMER_LIST_TABS.has(customerTab)) return;
    // Same discipline as loadOrders: sequence the requests so a slow response
    // can never repaint over a newer one, and paint revisited tabs instantly
    // from cache while revalidating — the section used to blank on every tab,
    // page and search change, which is what made it feel choppy.
    const key = `${customerTab}|${customerPage}|${customerSearchDebounced}|${customerBusinessType}|${customerBatch}`;
    const seq = (customersReqSeqRef.current += 1);
    const cached = customersCacheRef.current.get(key);
    if (cached) {
      setCustomerRows(cached.rows);
      setCustomerTotal(cached.total);
    } else if (customersCacheKeyRef.current !== key) {
      setCustomerRows([]);
    }
    customersCacheKeyRef.current = key;
    setLoading(true);
    try {
      const data = customerTab === 'proto-active'
        ? await fetchProtoActiveCustomersPage({ page: customerPage, pageSize: ADMIN_PAGE_SIZE, searchQuery: customerSearchDebounced, batch: customerBatch })
        : await fetchCustomersPage({
          page: customerPage,
          pageSize: ADMIN_PAGE_SIZE,
          tab: customerTab,
          searchQuery: customerSearchDebounced,
          businessType: customerBusinessType,
        });
      if (seq !== customersReqSeqRef.current) return; // superseded — drop it
      customersCacheRef.current.set(key, { rows: data.rows, total: data.total });
      setCustomerRows(data.rows);
      setCustomerTotal(data.total);
      if (data.migrationRequired && data.message) showToast(data.message, 'warning');
    } catch (err) {
      if (seq === customersReqSeqRef.current) {
        showToast(err.message || 'Failed to load customers', 'error');
        if (!cached) { setCustomerRows([]); setCustomerTotal(0); }
      }
    } finally {
      if (seq === customersReqSeqRef.current) setLoading(false);
    }
  };

  const [exportingCustomers, setExportingCustomers] = useState(false);
  const handleExportAllCustomers = async () => {
    if (exportingCustomers) return;
    setExportingCustomers(true);
    try {
      const { exportAllCustomersXlsx } = await import('../lib/exportCustomers');
      const counts = await exportAllCustomersXlsx();
      showToast(`Exported ${counts.portal} portal customer(s) and ${counts.preRegistration} pre-registration contact(s)`);
    } catch (err) {
      showToast(err.message || 'Customer export failed', 'error');
    } finally {
      setExportingCustomers(false);
    }
  };

  const saveProtoActiveName = async (row, field, value) => {
    const trimmed = String(value || '').trim();
    const current = String(row[field] || '').trim();
    if (trimmed === current) return;
    setProtoNameSaving(`${row.id}-${field}`);
    try {
      const updated = await updateProtoActiveCustomer(row.id, { [field]: trimmed || null });
      setCustomerRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      if (profileCustomer?.id === row.id) setProfileCustomer((p) => ({ ...p, ...updated }));
      showToast('Saved', 'success');
    } catch (err) {
      showToast(err.message || 'Save failed', 'error');
    } finally {
      setProtoNameSaving(null);
    }
  };

  const [importingCustomers, setImportingCustomers] = useState(false);
  const customerCsvRef = useRef(null);

  const handleCustomerCsvUpload = async (file) => {
    if (!file) return;

    // Ask before importing, not after: the group label and tags are what make
    // the batch findable and emailable later, and there is no way to attribute
    // rows to an upload retrospectively once several share a timestamp.
    const defaultLabel = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} import`;
    const batchLabel = window.prompt(
      'Name this upload group (used to find and email these contacts later):',
      defaultLabel,
    );
    if (batchLabel === null) return; // cancelled — import nothing
    const tagsInput = window.prompt(
      'Tags for everyone in this upload, comma separated (leave blank for none):',
      '10000 club',
    );
    if (tagsInput === null) return;
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);

    setImportingCustomers(true);
    try {
      const { parseCustomerFile } = await import('../lib/customerCsvImport');
      const { rows, errors } = await parseCustomerFile(file);
      if (!rows.length) {
        showToast(errors[0] || 'No valid rows in that file', 'error');
        return;
      }
      // Upload in chunks so large files never hit request size/time limits.
      const CHUNK = 400;
      let imported = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const result = await importProtoActiveCustomers(rows.slice(i, i + CHUNK), batchLabel.trim() || defaultLabel, tags);
        imported += result.imported || 0;
        skipped += result.skipped || 0;
      }
      showToast(
        `Imported ${imported} contact(s) as "${batchLabel.trim() || defaultLabel}"${tags.length ? ` · tags: ${tags.join(', ')}` : ''}${skipped ? ` — ${skipped} skipped (duplicates/invalid)` : ''}${errors.length ? ` — ${errors.length} row(s) had errors` : ''}`,
        errors.length || skipped ? 'warning' : 'success',
      );
      await loadCustomers();
    } catch (err) {
      showToast(err.message || 'Customer import failed', 'error');
    } finally {
      setImportingCustomers(false);
    }
  };

  const handleDeleteAllProtoActive = async () => {
    const typed = window.prompt('This deletes EVERY pre-registration customer. Type DELETE ALL to confirm:');
    if (typed !== 'DELETE ALL') return;
    setSaving('del-all-proto');
    try {
      const result = await deleteAllProtoActiveCustomers();
      showToast(`Deleted ${result.deleted} pre-registration customer(s)`);
      await loadCustomers();
    } catch (err) {
      showToast(err.message || 'Delete all failed', 'error');
    } finally {
      setSaving('');
    }
  };

  const removeProtoActiveCustomer = async (row) => {
    if (!window.confirm(`Remove ${row.name || row.email} from the pre-registration list?`)) return;
    setSaving(`del-proto-${row.id}`);
    try {
      await deleteProtoActiveCustomer(row.id);
      await loadCustomers();
      if (profileCustomer?.id === row.id) closeCustomerProfile();
      showToast('Pre-registration contact removed');
    } catch (err) {
      showToast(err.message || 'Delete failed', 'error');
    } finally {
      setSaving('');
    }
  };

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const openProductManagerForSku = useCallback((sku) => {
    const cleanSku = String(sku || '').trim().toUpperCase();
    if (!cleanSku) return;
    setProductManagerSearch(cleanSku);
    setActiveSection('catalogue');
    setLoadingError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const openImageProcessingCentre = useCallback((handoff = {}) => {
    const nutstoreSelection = savePendingNutstoreHandoff(
      Array.isArray(handoff.nutstoreSelection) ? handoff.nutstoreSelection : [],
    );
    setImageProcessingHandoff({
      nutstoreSelection,
      uploadSelection: Array.isArray(handoff.uploadSelection) ? handoff.uploadSelection : [],
    });
    setActiveSection('image-processing');
    setLoadingError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const consumeNutstoreHandoff = useCallback(() => {
    clearPendingNutstoreHandoff();
    setImageProcessingHandoff((current) => ({ ...current, nutstoreSelection: [] }));
  }, []);

  useEffect(() => {
    const syncPendingNutstoreHandoff = (event) => {
      if (event.key !== IMAGE_PROCESSING_HANDOFF_KEY) return;
      const nutstoreSelection = loadPendingNutstoreHandoff();
      setImageProcessingHandoff((current) => ({ ...current, nutstoreSelection }));
    };
    window.addEventListener('storage', syncPendingNutstoreHandoff);
    return () => window.removeEventListener('storage', syncPendingNutstoreHandoff);
  }, []);

  const openNutstore = useCallback(() => {
    setActiveSection('product-loader');
    setLoadingError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const rememberImageProcessingIntake = useCallback((options) => {
    setImageProcessingIntake(saveImageProcessingIntake(options));
  }, []);

  // `fresh` bypasses the counts endpoint's edge cache. Pass it after a write:
  // otherwise a rename can read back counts computed up to a minute earlier and
  // the renamed category shows a stale badge — or none — as if it had failed.
  const reloadTaxonomy = async ({ fresh = false } = {}) => {
    const tree = await fetchTaxonomy();
    setTaxonomyTree(tree);
    setLiveTaxonomyTree(tree);
    try {
      const counts = await fetchCategoryProductCounts({ fresh });
      setCategoryProductCounts(counts);
    } catch { /* optional */ }
    return tree;
  };

  const handleTaxonomyConflict = async (err) => {
    if (err.status === 409) {
      showToast(err.message || 'Categories were changed by someone else — reloading', 'error');
      await reloadTaxonomy();
      return true;
    }
    return false;
  };

  const handleCategoryReorder = async (newTree) => {
    setTaxonomyTree(newTree);
    setLiveTaxonomyTree(newTree);
    setTaxonomySaving(true);
    try {
      await replaceFullTaxonomy(newTree);
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      showToast('Category order saved — live site updates within ~30 seconds', 'success');
    } catch (err) {
      if (await handleTaxonomyConflict(err)) return;
      showToast(err.message || 'Failed to save category order', 'error');
      const reverted = await fetchTaxonomy();
      setTaxonomyTree(reverted);
      setLiveTaxonomyTree(reverted);
    } finally {
      setTaxonomySaving(false);
    }
  };

  const loadOrders = async () => {
    // Tab switches and the 30s auto-refresh can put several requests in
    // flight at once; a slow response landing after a newer one used to
    // repaint the list with stale rows — the "order flickers away" bug. Only
    // the latest request may touch state.
    const key = `${orderTab}|${orderPage}|${orderPageSize}|${orderSearchDebounced}`;
    const seq = (ordersReqSeqRef.current += 1);
    // Paint a previously seen tab instantly from cache while revalidating, so
    // switching tabs never blanks the list or shows another tab's orders.
    const cached = ordersCacheRef.current.get(key);
    if (cached) {
      setOrders(cached.rows);
      paintedOrdersRef.current = cached.rows;
      setOrderTotal(cached.total);
      setOrdersLoadedKey(key);
    } else if (ordersCacheKeyRef.current !== key) {
      // Unseen tab: clear rather than leave the previous tab's rows on screen.
      setOrders([]);
      paintedOrdersRef.current = [];
    }
    ordersCacheKeyRef.current = key;
    setLoading(true);
    try {
      const data = await fetchOrdersPage({
        page: orderPage,
        pageSize: orderPageSize,
        search: orderSearchDebounced,
        tab: orderTab,
      });
      if (seq !== ordersReqSeqRef.current) return; // superseded — drop it
      setOrderTrashEnabled(data.orderTrashEnabled);
      // The 30s/focus refresh usually returns exactly what is already on
      // screen. Replacing state with an identical-but-new array still
      // re-renders every row AND re-fires the per-row detail effects below
      // (confirmation status, presale invoices, payment records), which is
      // what made the Payment and All-orders tabs visibly blink on every
      // refresh. If nothing changed, change nothing.
      const sig = JSON.stringify([data.total, data.rows.map((r) => [r.id, r.status, r.updated_at, r.confirmation_sent_at ?? null])]);
      const prevEntry = ordersCacheRef.current.get(key);
      // `orders` used to be read here. In the timer/focus callbacks that value
      // is whatever it was when the closure was made, so a stale length could
      // match data.rows.length and mark the response "unchanged" while the
      // screen was actually showing nothing — the rows then never painted and
      // only a manual refresh brought them back. Compare against what is
      // genuinely on screen, and never skip the paint when nothing is.
      const painted = paintedOrdersRef.current;
      const unchanged = prevEntry?.sig === sig
        && ordersCacheKeyRef.current === key
        && painted.length === data.rows.length
        && (painted.length > 0 || data.rows.length === 0);
      ordersCacheRef.current.set(key, { rows: data.rows, total: data.total, sig });
      if (!unchanged) {
        setOrders(data.rows);
        paintedOrdersRef.current = data.rows;
        setOrderTotal(data.total);
      }
      // Marks the rows on screen as belonging to this request, whether or not
      // the paint was skipped as unchanged.
      setOrdersLoadedKey(key);
      if (data.tabCounts) {
        const countsSig = JSON.stringify(data.tabCounts);
        if (orderTabCountsSigRef.current !== countsSig) {
          orderTabCountsSigRef.current = countsSig;
          setOrderTabCounts(data.tabCounts);
        }
        const badge = data.tabCounts.unpaid ?? data.tabCounts.new;
        if (badge != null) setNewOrdersCount(badge);
      }
    } catch (err) {
      if (seq === ordersReqSeqRef.current) {
        showToast(err.message || 'Failed to load orders', 'error');
        // Settle the key even on failure. Without this the list is stuck
        // "Loading orders…" for good after one failed fetch, because nothing
        // else ever marks the request finished — the toast would be the only
        // hint anything went wrong.
        setOrdersLoadedKey(key);
      }
    } finally {
      if (seq === ordersReqSeqRef.current) setLoading(false);
    }
  };

  const activeFulfillmentUser = useMemo(
    () => fulfillmentUsers.find((u) => u.id === activeFulfillmentUserId) || null,
    [fulfillmentUsers, activeFulfillmentUserId],
  );
  const victorCanSend = isVictorSender(activeFulfillmentUser);

  // "Mark as completed" only makes sense before the order reaches Payment, and
  // only for someone allowed to record payment — so the actions column widens
  // to fit the label exactly on the tabs where the button is shown.
  const showMarkCompleted = orderTab !== 'paid' && victorCanSend;

  const orderListGridCols = orderTab === 'sent' || orderTab === 'paid'
    ? `1.3fr 1.1fr 0.9fr 0.8fr 2fr ${showMarkCompleted ? '272px' : '120px'} 56px`
    : `1.4fr 1.3fr 1.1fr 0.8fr 1fr ${showMarkCompleted ? '312px' : '160px'} 80px`;

  const confirmationSentIds = useMemo(() => {
    const ids = new Set(Object.keys(confirmationSent).filter((id) => confirmationSent[id]?.sentAt));
    for (const order of orders) {
      if (order.confirmation_sent_at) ids.add(String(order.id));
    }
    return ids;
  }, [confirmationSent, orders]);

  // Load the WhatsApp-sent tags for whatever orders are on screen.
  //
  // Keyed on the joined id string, not the orders array: the list refreshes on
  // a 30s timer and on focus, and each refresh hands back a new array identity
  // even when nothing changed. Depending on `orders` would refetch these tags
  // every 30 seconds for no reason — the same trap the confirmationSentIds
  // comment below warns about.
  const orderIdsKey = useMemo(
    () => orders.map((o) => o.id).filter(Boolean).join(','),
    [orders],
  );
  useEffect(() => {
    const ids = orderIdsKey ? orderIdsKey.split(',') : [];
    if (!ids.length) { setTeamWaSent({}); return undefined; }
    let alive = true;
    void (async () => {
      try {
        const sent = await fetchTeamWhatsappSent(ids);
        if (alive) setTeamWaSent(sent);
      } catch { /* the tag is informational — never block the list on it */ }
    })();
    return () => { alive = false; };
  }, [orderIdsKey]);

  const sendTeamWhatsapp = async (order) => {
    setSaving(`wa-${order.id}`);
    try {
      const json = await sendTeamWhatsappApi(order.id);
      if (json.record) setTeamWaSent((prev) => ({ ...prev, [order.id]: json.record }));
      const failures = (json.results || []).filter((r) => !r.ok);
      if (!failures.length) {
        showToast(`Sent to all ${json.sentCount} team members`, 'success');
      } else {
        // A bare "6 failed" is not actionable — the whole point is knowing WHICH
        // number and WHY, so the admin can go fix that team member's entry.
        const names = failures.map((f) => f.name || f.phone).join(', ');
        const reasons = [...new Set(failures.map((f) => f.error).filter(Boolean))];
        showToast(
          `Sent to ${json.sentCount} of ${json.total}. Failed: ${names}`
            + (reasons.length === 1 ? ` — ${reasons[0]}` : ''),
          'error',
        );
        console.warn('Team WhatsApp failures:', failures);
      }
    } catch (err) {
      showToast(err.message || 'WhatsApp broadcast failed', 'error');
    } finally {
      setSaving('');
    }
  };

  const renderOrderConfirmationActions = (order) => {
    if (normalizeOrderStatus(order.status) !== 'order sent') return null;
    if (isOrderConfirmationSent(order, confirmationSentIds)) return null;
    const invoice = presaleInvoices[order.id];
    const uploading = presaleUploading === order.id;
    const sending = saving === `send-${order.id}`;
    return (
      <div className="adm-oc-col">
        <span className="adm-oc-label">Order Confirmation</span>
        <label className="adm-oc-upload-btn">
          {uploading ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {invoice ? 'Replace invoice' : 'Upload invoice'}
          <input
            type="file"
            accept=".pdf,application/pdf,image/*"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handlePresaleUpload(order, file);
            }}
          />
        </label>
        {invoice && <span className="adm-oc-uploaded">✓ {invoice.filename || 'Invoice uploaded'}</span>}
        {victorCanSend ? (
          <button
            type="button"
            className="adm-oc-send-btn"
            disabled={sending}
            onClick={() => void sendOrderConfirmation(order)}
          >
            {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
            {sending ? 'Sending…' : 'Send'}
          </button>
        ) : (
          <span className="adm-oc-victor-gate" title={CUSTOMER_SEND_FORBIDDEN}>Victor only</span>
        )}
      </div>
    );
  };

  const renderPaymentActions = (order) => {
    const key = normalizeOrderStatus(order.status);
    if (key === 'payment received') {
      const pop = paymentRecords[order.id];
      return (
        <div className="adm-oc-col">
          <span className="adm-oc-label adm-oc-label--paid">Paid</span>
          {pop?.filename && <span className="adm-oc-uploaded">✓ {pop.filename}</span>}
        </div>
      );
    }
    if (key !== 'order sent' || !isOrderConfirmationSent(order, confirmationSentIds)) return null;

    const pop = paymentRecords[order.id];
    const uploading = popUploading === order.id;
    const isPaid = pop?.paid === true;

    return (
      <div className="adm-oc-col">
        <span className="adm-oc-label">Awaiting payment</span>
        <div className="adm-pay-toggle">
          <button
            type="button"
            className={`adm-pay-toggle__btn${!isPaid ? ' adm-pay-toggle__btn--on' : ''}`}
            onClick={() => void handlePaymentStatus(order, false)}
          >
            Not paid
          </button>
          <button
            type="button"
            className={`adm-pay-toggle__btn${isPaid ? ' adm-pay-toggle__btn--on' : ''}`}
            onClick={() => void handlePaymentStatus(order, true)}
          >
            Paid
          </button>
        </div>
        <label className="adm-oc-upload-btn">
          {uploading ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
          {pop?.filename ? 'Replace POP' : 'Upload POP'}
          <input
            type="file"
            accept=".pdf,application/pdf,image/*"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handlePopUpload(order, file);
            }}
          />
        </label>
        {pop?.filename && <span className="adm-oc-uploaded">✓ {pop.filename}</span>}
        {isPaid && (
          victorCanSend ? (
            <button
              type="button"
              className="adm-presale-pay-btn"
              disabled={saving === `advance-${order.id}`}
              onClick={() => void advanceOrderStatus(order, 'payment received')}
            >
              <Check size={14} strokeWidth={2.5} />
              {saving === `advance-${order.id}` ? 'Updating…' : 'Confirm payment'}
            </button>
          ) : (
            <span className="adm-oc-victor-gate" title={PAYMENT_RECEIVED_FORBIDDEN}>Victor only</span>
          )
        )}
      </div>
    );
  };

  const handlePresaleUpload = async (order, file) => {
    setPresaleUploading(order.id);
    try {
      const meta = await uploadPresaleInvoice(order.id, file);
      setPresaleInvoices((prev) => ({ ...prev, [order.id]: meta }));
      showToast(`Presale invoice uploaded for ${order.order_number || order.id.slice(0, 8)}`);
    } catch (err) {
      showToast(err.message || 'Upload failed', 'error');
    } finally {
      setPresaleUploading('');
    }
  };

  const handlePopUpload = async (order, file) => {
    setPopUploading(order.id);
    try {
      const meta = await uploadPop(order.id, file, { paid: paymentRecords[order.id]?.paid !== false });
      setPaymentRecords((prev) => ({ ...prev, [order.id]: meta }));
      showToast(`Proof of payment uploaded for ${order.order_number || order.id.slice(0, 8)}`);
    } catch (err) {
      showToast(err.message || 'Upload failed', 'error');
    } finally {
      setPopUploading('');
    }
  };

  const handlePaymentStatus = async (order, paid) => {
    setSaving(`pay-${order.id}`);
    try {
      const meta = await setPaymentStatus(order.id, paid);
      setPaymentRecords((prev) => ({ ...prev, [order.id]: { ...prev[order.id], ...meta } }));
    } catch (err) {
      showToast(err.message || 'Failed to update payment status', 'error');
    } finally {
      setSaving('');
    }
  };

  const sendOrderConfirmation = async (order) => {
    const email = order.customers?.email;
    if (!email) {
      showToast('This customer has no email address on file.', 'error');
      return;
    }
    if (!victorCanSend) {
      showToast(CUSTOMER_SEND_FORBIDDEN, 'error');
      return;
    }
    const invoiceAttached = Boolean(presaleInvoices[order.id]);
    const confirmMsg = invoiceAttached
      ? `Send order confirmation + presale invoice to ${email}?`
      : `Send order confirmation to ${email}? (No presale invoice uploaded yet)`;
    if (!window.confirm(confirmMsg)) return;

    setSaving(`send-${order.id}`);
    try {
      const emailItems = buildEmailItemsFromOrder(order);
      const autoNotes = deriveAutoNotesFromItems(emailItems).join('\n');
      const { hasPrices, total, items: customerItems } = resolveCustomerOrderPricing(emailItems);
      const pdfBase64 = await generateOrderPdfBase64({
        order,
        items: customerItems,
        autoNotes,
        userNotes: order.order_change_notes || '',
        assignedTo: activeFulfillmentUser?.name || '',
        total,
        hasPrices,
      });
      // Upload the PDF straight to storage via a signed URL so we never hit
      // Vercel's 4.5 MB request-body limit (large PDFs used to 413 on send).
      const urlRes = await fetch('/api/order-confirmation-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok) throw new Error(urlData.error || 'Could not prepare PDF upload');
      const putRes = await fetch(urlData.signedUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf', 'x-upsert': 'true' },
        body: base64ToBlob(pdfBase64, 'application/pdf'),
      });
      if (!putRes.ok) throw new Error('Could not upload order confirmation PDF');
      const emailRes = await fetch('/api/send-order-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          to: email,
          customerName: order.customers?.name,
          orderNumber: displayOrderNumber(order),
          orderDate: order.created_at,
          items: customerItems,
          autoNotes,
          userNotes: order.order_change_notes || '',
          assignedTo: activeFulfillmentUser?.name || '',
          total,
          hasPrices,
          senderUserId: activeFulfillmentUser?.id || '',
          senderName: activeFulfillmentUser?.name || '',
          confirmationStoragePath: urlData.path,
          pdfFilename: `proto-order-confirmation-${displayOrderNumber(order)}.pdf`,
          deliveryMethod: order.delivery_method || '',
          customerNotes: order.customer_notes || '',
        }),
      });
      const emailData = await emailRes.json();
      if (!emailRes.ok) throw new Error(emailData.error || 'Email send failed');
      if (normalizeOrderStatus(order.status) !== 'order sent') {
        await advanceOrderWorkflow(order.id, 'order sent', {
          senderUserId: activeFulfillmentUser?.id,
          senderName: activeFulfillmentUser?.name,
        });
        setOrders((prev) => prev.map((item) => (
          item.id === order.id ? { ...item, status: 'order sent' } : item
        )));
      }
      const sentMeta = await markConfirmationSent(order.id);
      setConfirmationSent((prev) => ({ ...prev, [order.id]: sentMeta }));
      setOrders((prev) => prev.map((item) => (
        item.id === order.id
          ? { ...item, confirmation_sent_at: sentMeta.sentAt || sentMeta.updatedAt }
          : item
      )));
      setOrderTab('paid');
      showToast(`Confirmation sent to ${email}${emailData.presaleIncluded ? ' with presale invoice' : ''} — moved to Payment`);
    } catch (err) {
      showToast(err.message || 'Could not send order confirmation', 'error');
    } finally {
      setSaving('');
    }
  };

  useEffect(() => { if (activeSection === 'customers') void loadCustomers(); }, [activeSection, customerPage, customerTab, customerSearchDebounced, customerBusinessType]);
  useEffect(() => { setCustomerListExpanded(false); }, [customerTab]);
  // Pricing load lives in PricingPanel.
  useEffect(() => { void reloadTaxonomy(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const section = normalizeRequestedAdminSection(params.get('section') || params.get('view'));
    const tab = params.get('orderTab');
    const focus = params.get('focusOrder');
    // Deep links must respect the same role allowlist as the visible sidebar.
    // Without this check, a restricted user could open a hidden section with
    // `?section=...` even though the navigation correctly omitted it.
    if (section && allowedSectionIds.includes(section)) setActiveSection(section);
    if (tab) setOrderTab(tab);
    if (focus) setFocusOrderId(focus);
  }, [allowedSectionIds]);

  useEffect(() => {
    replaceAdminSectionUrl(activeSection);
  }, [activeSection]);

  useEffect(() => {
    if (!focusOrderId || activeSection !== 'orders' || !orders.length) return;
    setExpandedOrderId(focusOrderId);
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-order-id="${focusOrderId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFocusOrderId('');
    }, 300);
    return () => clearTimeout(timer);
  }, [focusOrderId, activeSection, orders]);
  useEffect(() => { if (activeSection === 'orders') void loadOrders(); }, [activeSection, orderPage, orderTab, orderPageSize, orderSearchDebounced]);
  useEffect(() => {
    if (activeSection !== 'orders') return;
    setOrdersBadgeSeen(newOrdersCount);
    try { localStorage.setItem('adm-orders-badge-seen', String(newOrdersCount)); } catch { /* ignore */ }
  }, [activeSection, newOrdersCount]);
  useEffect(() => {
    if (activeSection !== 'orders') return undefined;
    fetchFulfillmentUsers()
      .then((rows) => setFulfillmentUsers(rows))
      .catch(() => {});
    const syncUser = () => setActiveFulfillmentUserId(loadActiveUserId());
    window.addEventListener('storage', syncUser);
    window.addEventListener('focus', syncUser);
    return () => {
      window.removeEventListener('storage', syncUser);
      window.removeEventListener('focus', syncUser);
    };
  }, [activeSection]);

  // Merge fetched per-order detail into a map WITHOUT changing state identity
  // when nothing is new — a same-content setState here re-renders the whole
  // order list, and these effects run on every refresh cycle.
  const mergeMapIfChanged = (setter) => (rows) => setter((prev) => {
    let changed = false;
    for (const k of Object.keys(rows || {})) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(rows[k])) { changed = true; break; }
    }
    return changed ? { ...prev, ...rows } : prev;
  });

  // One effect, not the previous two overlapping copies of it (both fetched
  // confirmation status on every orders change, one without a section guard).
  useEffect(() => {
    if (activeSection !== 'orders') return;
    const ids = orders.filter((o) => normalizeOrderStatus(o.status) === 'order sent').map((o) => o.id);
    if (!ids.length) return;
    fetchPresaleInvoices(ids)
      .then(mergeMapIfChanged(setPresaleInvoices))
      .catch((err) => showToast(err.message || 'Failed to load presale invoices', 'error'));
    fetchConfirmationSent(ids)
      .then(mergeMapIfChanged(setConfirmationSent))
      .catch((err) => showToast(err.message || 'Failed to load confirmation status', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, orderTab, orders]);

  useEffect(() => {
    if (activeSection !== 'orders' || orderTab !== 'paid') return;
    const ids = orders
      .filter((o) => orderMatchesTab(o, 'paid', { confirmationSentIds }))
      .map((o) => o.id);
    if (!ids.length) return;
    fetchPaymentRecords(ids)
      .then(mergeMapIfChanged(setPaymentRecords))
      .catch((err) => showToast(err.message || 'Failed to load payment records', 'error'));
    fetchConfirmationSent(ids)
      .then(mergeMapIfChanged(setConfirmationSent))
      .catch((err) => showToast(err.message || 'Failed to load confirmation status', 'error'));
    // NOTE: confirmationSentIds is intentionally NOT a dependency. It is a
    // useMemo that returns a new Set whenever confirmationSent changes, and this
    // effect calls setConfirmationSent — so including it created an infinite
    // fetch/re-render loop (orders flickering every couple of seconds on the
    // Payment tab). Re-running on orders/tab change is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, orderTab, orders]);

  useEffect(() => {
    if (activeSection !== 'orders') return undefined;
    const refresh = () => { if (document.visibilityState === 'visible') void loadOrders(); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [activeSection]);

  // Remember the expanded order's row while it is present in the list, and
  // unpin the moment it reappears (e.g. the admin switched to the tab it
  // moved to).
  useEffect(() => {
    const row = orders.find((o) => o.id === expandedOrderId);
    if (row) {
      lastExpandedRowRef.current = row;
      setPinnedOrder((prev) => (prev ? null : prev));
    }
  }, [orders, expandedOrderId]);

  // An expanded order can vanish mid-fulfilment: the team's first tick
  // advances its status server-side (pending -> order in progress), and the
  // next 30s/focus refresh drops it from the tab the admin is looking at.
  // Losing the panel you are working in with no explanation reads as a bug,
  // so keep the open order pinned at the top of the list until it is
  // collapsed or the admin changes tab, and say what happened once.
  useEffect(() => {
    if (!expandedOrderId) { setPinnedOrder(null); return; }
    if (loading) return; // only judge settled lists, never mid-refresh blanks
    if (orders.some((o) => o.id === expandedOrderId)) return;
    const remembered = lastExpandedRowRef.current;
    if (!remembered || remembered.id !== expandedOrderId) return;
    setPinnedOrder((prev) => (prev?.id === expandedOrderId ? prev : remembered));
    if (pinToastForRef.current !== expandedOrderId) {
      pinToastForRef.current = expandedOrderId;
      showToast(`Order ${remembered.order_number || ''} advanced out of this tab — kept on screen while open`.replace('  ', ' '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, expandedOrderId, loading]);

  // A deliberate tab/page/search change is a navigation, not a vanish — drop
  // the pin and let the new list speak for itself.
  useEffect(() => {
    setPinnedOrder(null);
  }, [orderTab, orderPage, orderSearchDebounced]);

  // Load specials on mount
  useEffect(() => {
    fetchSpecials().then((data) => setSpecials(data?.items || [])).catch(() => {});
  }, []);

  // Poll pending trade applications + new orders for sidebar badges
  useEffect(() => {
    const load = async () => {
      try {
        const [requests, ordersData] = await Promise.all([
          fetchCustomersPage({ tab: 'requests', pageSize: 1, searchQuery: '' }),
          fetchOrdersPage({ tab: 'new', pageSize: 1, page: 1 }),
        ]);
        setPendingCount(requests.total || 0);
        setNewOrdersCount(ordersData.tabCounts?.unpaid ?? ordersData.tabCounts?.new ?? 0);
      } catch { /* badges are best-effort */ }
    };
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);

  const specialsSet = new Set(specials.map((s) => s.productId));

  const toggleSpecial = async (product) => {
    let next;
    if (specialsSet.has(product.id)) {
      next = specials.filter((s) => s.productId !== product.id);
    } else {
      if (specials.length >= 10) { alert('Maximum 10 specials allowed. Remove one first.'); return; }
      next = [...specials, { productId: product.id, productName: product.name, productCode: product.code, productImage: product.image || '', deal: 'none', discountPct: 10, bogoX: 1, bogoY: 1 }];
    }
    setSpecials(next);
    setSpecialsSaving(true);
    try { await saveSpecials(next); } catch (err) { showToast(err.message || 'Failed to save specials', 'error'); } finally { setSpecialsSaving(false); }
  };

  const updateSpecialDeal = async (productId, patch) => {
    const next = specials.map((s) => s.productId === productId ? { ...s, ...patch } : s);
    setSpecials(next);
    setSpecialsSaving(true);
    try { await saveSpecials(next); } catch (err) { showToast(err.message || 'Failed to save specials', 'error'); } finally { setSpecialsSaving(false); }
  };

  const clearAllSpecials = async () => {
    if (!window.confirm('Remove all specials?')) return;
    setSpecials([]);
    setSpecialsSaving(true);
    try { await saveSpecials([]); } catch (err) { showToast(err.message || 'Failed to save specials', 'error'); } finally { setSpecialsSaving(false); }
  };

  const uploadImageFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setContentEditError('Only image files are supported.');
      return;
    }
    setImageUploading(true);
    setContentEditError('');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/upload-product-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, base64 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      setContentEditForm((f) => ({ ...f, image: json.url }));
    } catch (err) {
      setContentEditError(err.message || 'Image upload failed');
    } finally {
      setImageUploading(false);
    }
  };

  const uploadEditorImageFile = async (file, slotKey) => {
    if (!file || !file.type.startsWith('image/')) {
      setEditorError('Only image files are supported.');
      return;
    }
    setEditorImageUploading(true);
    setEditorError('');
    try {
      const url = await uploadDormantImage(file);
      setProductForm((current) => ({ ...current, [slotKey]: url }));
    } catch (err) {
      setEditorError(err.message || 'Image upload failed');
    } finally {
      setEditorImageUploading(false);
    }
  };

  const stats = useMemo(() => ({
    products: dashStats?.liveProducts ?? catalogTotal,
    archived: dashStats?.archivedProducts ?? archiveCatalogTotal,
    customers: dashStats?.customers ?? statsCustomerTotal,
    orders: dashStats?.orders ?? statsOrderTotal,
  }), [dashStats, catalogTotal, archiveCatalogTotal, statsCustomerTotal, statsOrderTotal]);

  const activeSectionLabel = useMemo(
    () => NAV_GROUPS.find((item) => item.id === activeSection)?.label || 'Admin',
    [activeSection],
  );

  const orderRows = useMemo(() => {
    if (!pinnedOrder || orders.some((o) => o.id === pinnedOrder.id)) return orders;
    return [{ ...pinnedOrder, __pinned: true }, ...orders];
  }, [orders, pinnedOrder]);

  const openNewProduct = () => {
    const firstCategory = taxonomyTree[0]?.id || categories[0]?.id || '';
    const firstChild = subcategoryOptions(firstCategory, taxonomyTree)[0]?.id || '';
    setEditingProduct(null);
    setProductForm({
      ...emptyForm,
      categoryId: firstCategory,
      childIds: firstChild ? [firstChild] : [],
    });
    setEditorError('');
    setEditorImageUploading(false);
    setEditorImageDragOver('');
    setEditorOpen(true);
  };

  const openEditProduct = (product) => {
    setEditingProduct(product);
    setProductForm({ ...productToForm(product, taxonomyTree), availabilityLoading: true });
    setEditorError('');
    setEditorImageUploading(false);
    setEditorImageDragOver('');
    setEditorOpen(true);
    if (!product.archivedBy) {
      void fetchProductAvailability(product.id)
        .then((result) => {
          setProductForm((current) => {
            if (current.code !== (product.code || '')) return current;
            const availability = result?.availability || {};
            return {
              ...current,
              availabilityLoading: false,
              availabilitySchemaReady: result?.schemaReady === true,
              incomingStatus: availability.incomingStatus || 'none',
              incomingQty: availability.incomingQty > 0 ? String(availability.incomingQty) : '',
              incomingEta: availability.incomingEta || '',
              shipmentRef: availability.shipmentRef || '',
              allowPreorder: !!availability.allowPreorder,
            };
          });
        })
        .catch((error) => {
          setProductForm((current) => ({ ...current, availabilityLoading: false }));
          setEditorError(error.message || 'Could not load incoming-stock status');
        });
    }
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingProduct(null);
    setEditorError('');
    setEditorImageUploading(false);
    setEditorImageDragOver('');
  };

  const swapEditorImageSlots = (index) => {
    setProductForm((current) => {
      const keys = PRODUCT_IMAGE_SLOTS.map((s) => s.key);
      const next = { ...current };
      const a = keys[index];
      const b = keys[index + 1];
      if (!a || !b) return current;
      next[a] = current[b] || '';
      next[b] = current[a] || '';
      return next;
    });
  };

  const clearEditorImage = (slotKey) => {
    setProductForm((current) => ({ ...current, [slotKey]: '' }));
  };

  const openContentEdit = (product) => {
    setContentEditProduct(product);
    setContentEditForm({
      image: product.image || '',
      description: product.description || '',
      packDescription: product.packDescription || '',
      unitsOfIssue: product.unitsOfIssue || 'EACH',
      code: product.code || product.barcode || '',
    });
    setContentEditError('');
  };

  const closeContentEdit = () => { setContentEditProduct(null); setContentEditError(''); };

  const saveContentEdit = async () => {
    if (!contentEditProduct) return;
    setContentEditSaving(true);
    setContentEditError('');
    try {
      await updateProduct(contentEditProduct.id, {
        image: contentEditForm.image.trim(),
        description: contentEditForm.description,
        packDescription: contentEditForm.packDescription,
        unitsOfIssue: contentEditForm.unitsOfIssue,
        code: contentEditForm.code?.trim() || '',
      });
      // Update local lists so image/description reflects the change without a full reload
      const patch = {
        image: contentEditForm.image.trim(),
        description: contentEditForm.description,
        packDescription: contentEditForm.packDescription,
        unitsOfIssue: contentEditForm.unitsOfIssue,
        code: contentEditForm.code?.trim() || '',
        barcode: contentEditForm.code.trim(),
      };
      reorderPanelRef.current?.patchProduct?.(contentEditProduct.id, patch);
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      invalidateProductCache();
      closeContentEdit();
    } catch (err) {
      setContentEditError(err.message || 'Save failed');
    } finally {
      setContentEditSaving(false);
    }
  };

  const refreshCurrentSection = async () => {
    if (activeSection === 'customers') {
      return loadCustomers();
    }
    if (activeSection === 'reorder') {
      reorderPanelRef.current?.refresh?.();
      return reloadTaxonomy();
    }
    if (activeSection === 'orders') {
      return loadOrders();
    }
    if (activeSection === 'catalogue') {
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      return reloadTaxonomy();
    }
    if (activeSection === 'analytics') {
      dispatchAdminRefresh('analytics');
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
      return;
    }
    dispatchAdminRefresh(activeSection);
  };

  const saveProduct = async () => {
    const categoryPath = [productForm.categoryId, ...(productForm.childIds || [])].filter(Boolean);

    if (!categoryPath.length && !editingProduct?.archivedBy) {
      setEditorError('Pick a main category before saving — every product needs a category.');
      return;
    }

    // Archived rows keep whatever category they had (their category selector is
    // hidden — a category is chosen at Make live). Their stored path is often a
    // synthetic "Uncategorised › General" that the live taxonomy can't resolve,
    // so sending it back would 409 ("Destination category changed") and block a
    // plain code/price edit. Only live/new products send a category path.
    const sendCategory = categoryPath.length > 0 && !editingProduct?.archivedBy;

    const payload = {
      code: productForm.code.trim(),
      name: productForm.name.trim(),
      description: productForm.description,
      packDescription: productForm.packDescription,
      unitsOfIssue: productForm.unitsOfIssue,
      minQty: Number(productForm.minQty),
      image: productForm.image.trim(),
      secondaryImage: productForm.secondaryImage.trim(),
      imageThree: productForm.imageThree.trim(),
      imageFour: productForm.imageFour.trim(),
      price: Number(productForm.price || 0),
      ...(sendCategory ? { categoryPath } : {}),
      ...(editingProduct?.updatedAt ? { expectedUpdatedAt: editingProduct.updatedAt } : {}),
    };
    setSaving(editingProduct?.id || 'new-product');
    try {
      const result = editingProduct
        ? await updateProduct(editingProduct.id, payload)
        : await createProduct(payload);
      if (result?.relink?.matched) {
        showToast('Matched to Positill — refresh Archive to see live stock', 'success');
      }
      // Live-only flags live in website_stock (separate from the product update):
      // apply the New-Stock ribbon / To-order toggles when they changed. These
      // used to be per-row buttons; they now live in this modal.
      if (editingProduct && !editingProduct.archivedBy) {
        if (!!productForm.isNewArrival !== !!editingProduct.isNew) {
          await setNewArrival(editingProduct.id, productForm.isNewArrival);
        }
        if (!!productForm.toOrder !== !!editingProduct.toOrder) {
          await setToOrder(editingProduct.id, productForm.toOrder);
        }
        if (productForm.availabilitySchemaReady) {
          await setProductAvailability(editingProduct.id, {
            incomingStatus: productForm.incomingStatus,
            incomingQty: productForm.incomingQty,
            incomingEta: productForm.incomingEta,
            shipmentRef: productForm.shipmentRef,
            allowPreorder: productForm.allowPreorder,
          });
        }
      }
      closeEditor();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      invalidateProductCache();
      invalidateAdminCache();
    } catch (err) {
      setEditorError(err.message || 'Save failed');
    } finally { setSaving(''); }
  };




  // Banner + Specials editors now live in BannerPanel / SpecialsPanel.



  const saveTaxonomyRename = async () => {
    if (!editTaxonomyModal?.label?.trim()) return;
    setTaxonomySaving(true);
    try {
      const renameResult = await renameTaxonomyNode(editTaxonomyModal.id, editTaxonomyModal.label.trim());
      await reloadTaxonomy({ fresh: true });
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await reorderPanelRef.current?.refresh?.();
      setEditTaxonomyModal(null);
      // A rename is now all-or-nothing server-side: a product-label failure
      // rolls the tree back and returns an error, so reaching here means the
      // category and every one of its products moved together.
      showToast(
        renameResult?.productsRenamed
          ? `Category updated — ${renameResult.productsRenamed} product(s) renamed`
          : 'Category updated',
      );
    } catch (err) {
      if (await handleTaxonomyConflict(err)) {
        setEditTaxonomyModal(null);
        return;
      }
      showToast(err.message || 'Update failed', 'error');
    } finally { setTaxonomySaving(false); }
  };

  const saveNewSubcategory = async () => {
    if (!newSubModal?.label?.trim() || !newSubModal?.parentId) return;
    setTaxonomySaving(true);
    try {
      const json = await createSubcategory(newSubModal.parentId, newSubModal.label.trim());
      await reloadTaxonomy();
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      setNewSubModal(null);
      reorderPanelRef.current?.applySubcategoryCreated?.(json, newSubModal.parentId);
      showToast(json.created ? 'Subcategory created' : 'Subcategory already exists');
    } catch (err) {
      if (await handleTaxonomyConflict(err)) {
        setNewSubModal(null);
        return;
      }
      showToast(err.message || 'Create failed', 'error');
    } finally { setTaxonomySaving(false); }
  };

  const saveNewCategory = async () => {
    if (!newCategoryModal?.label?.trim()) return;
    setTaxonomySaving(true);
    try {
      const json = await createCategory(newCategoryModal.label.trim());
      await reloadTaxonomy();
      invalidateAdminCache();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      setNewCategoryModal(null);
      showToast(json.created ? 'Category created' : 'Category already exists');
    } catch (err) {
      if (await handleTaxonomyConflict(err)) {
        setNewCategoryModal(null);
        return;
      }
      showToast(err.message || 'Create failed', 'error');
    } finally { setTaxonomySaving(false); }
  };

  const openDeleteSubcategory = async (sub) => {
    setTaxonomySaving(true);
    try {
      const productCount = await countSubcategoryProducts(sub.id);
      setDeleteSubModal({ ...sub, productCount });
    } catch (err) {
      // Counting is best-effort — still let the user delete (products are kept).
      setDeleteSubModal({ ...sub, productCount: 0 });
    } finally { setTaxonomySaving(false); }
  };

  const confirmDeleteSubcategory = async () => {
    if (!deleteSubModal?.id) return;
    setTaxonomySaving(true);
    try {
      const deleteResult = await deleteTaxonomyNode(deleteSubModal.id);
      await reloadTaxonomy();
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
      reorderPanelRef.current?.onPathNodeDeleted?.(deleteSubModal.id);
      invalidateAdminCache();
      const isCat = deleteSubModal.type === 'category';
      setDeleteSubModal(null);
      if (deleteResult?.archiveError) {
        showToast(`Deleted, but some products were not archived: ${deleteResult.archiveError}`, 'error');
      } else if (deleteResult?.productsArchived > 0) {
        showToast(`${isCat ? 'Category' : 'Subcategory'} deleted — ${deleteResult.productsArchived} product(s) moved to Archive. Restore them from the Archive tab.`);
      } else {
        showToast(isCat ? 'Category deleted' : 'Subcategory deleted');
      }
    } catch (err) {
      if (await handleTaxonomyConflict(err)) {
        setDeleteSubModal(null);
        return;
      }
      showToast(err.message || 'Delete failed', 'error');
    } finally { setTaxonomySaving(false); }
  };

  const goHome = () => setActiveSection('orders');

  // Pricing selection + apply moved into PricingPanel.

  const openCustomerProfile = async (person, source = 'portal') => {
    const requestSeq = ++profileOrdersReqSeqRef.current;
    setProfileCustomer(person);
    setProfileSource(source);
    setProfileEditing(false);
    setProfileOrders([]);
    setProfileOrdersTotal(0);
    setProfileOrdersError('');
    setProfileOrdersLoading(false);
    if (source === 'proto-active') return;
    setProfileOrdersLoading(true);
    try {
      const res = await fetch(`/api/admin-orders?customerId=${person.id}&limit=20`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load order history');
      if (requestSeq !== profileOrdersReqSeqRef.current) return;
      setProfileOrders(json.rows || []);
      setProfileOrdersTotal(Number(json.total) || (json.rows || []).length);
    } catch (err) {
      if (requestSeq === profileOrdersReqSeqRef.current) setProfileOrdersError(err.message || 'Could not load order history');
    } finally {
      if (requestSeq === profileOrdersReqSeqRef.current) setProfileOrdersLoading(false);
    }
  };

  const closeCustomerProfile = () => { profileOrdersReqSeqRef.current += 1; setProfileCustomer(null); setProfileOrders([]); setProfileOrdersTotal(0); setProfileOrdersError(''); setProfileOrdersLoading(false); setProfileEditing(false); setProfileSource('portal'); };

  const SPEND_BANDS = ['R0 – R5,000', 'R5,000 – R10,000', 'R10,000 – R25,000', 'R25,000 – R50,000', 'R50,000+'];
  const startEditProfile = () => {
    setProfileForm({
      name: profileCustomer.name || '',
      email: profileCustomer.email || '',
      phone: profileCustomer.phone || '',
      business_name: profileCustomer.business_name || profileCustomer.name || '',
      business_type: profileCustomer.business_type || '',
      business_description: profileCustomer.business_description || '',
      monthly_spend: profileCustomer.monthly_spend || '',
      website: profileCustomer.website || '',
      vat_number: profileCustomer.vat_number || '',
      company_address: profileCustomer.company_address || '',
      delivery_address: profileCustomer.delivery_address || '',
      contact_name: profileCustomer.contact_name || '',
      first_name: profileCustomer.first_name || '',
      account_code: profileCustomer.account_code || profileCustomer.customer_code || '',
      customer_code: profileCustomer.customer_code || '',
    });
    setProfileEditing(true);
  };
  const saveProfileEdit = async () => {
    setSavingProfile(true);
    try {
      if (profileSource === 'proto-active') {
        const row = await updateProtoActiveCustomer(profileCustomer.id, {
          name: profileForm.business_name || profileForm.name,
          email: profileForm.email,
          contact_name: profileForm.contact_name,
          first_name: profileForm.first_name,
          account_code: profileForm.account_code,
        });
        setProfileCustomer(row);
        setProfileEditing(false);
        await loadCustomers();
        showToast('Pre-registration contact updated');
      } else {
        const res = await updateCustomerAdmin(profileCustomer.id, profileForm);
        setProfileCustomer(res.row);
        setProfileEditing(false);
        await loadCustomers();
        if (res.welcomeEmail === 'sent') showToast('Code saved — confirmation email sent');
        else if (res.welcomeEmail === 'failed') showToast('Saved, but the confirmation email failed to send', 'error');
        else showToast('Customer profile updated');
      }
    } catch (err) {
      showToast(err.message || 'Update failed', 'error');
    } finally { setSavingProfile(false); }
  };
  const setPf = (key) => (e) => setProfileForm((f) => ({ ...f, [key]: e.target.value }));

  const refreshPendingCount = async () => {
    try {
      const data = await fetchCustomersPage({ tab: 'requests', pageSize: 1, searchQuery: '' });
      setPendingCount(data.total || 0);
    } catch {}
  };

  const approveRequest = async (person) => {
    const customerCode = String(approvalCodes[person.id] || '').trim().toUpperCase();
    // A code is OPTIONAL at approval — approve now, allocate the code later. If
    // a code IS typed it must be valid; assigning it sends the confirmation email.
    if (customerCode && !/^[A-Z0-9]{6}$/.test(customerCode)) {
      showToast('Code must be 6 letters or numbers — or leave it blank to allocate later', 'error');
      return;
    }
    setSaving(person.id);
    try {
      const result = await approveCustomer(person.id, true, customerCode ? { customerCode } : {});
      setApprovalCodes((prev) => {
        const next = { ...prev };
        delete next[person.id];
        return next;
      });
      await refreshPendingCount();
      await refreshDashboardStats();
      // Stay on Trade Requests and remove the approved application from the
      // current list so admins can continue reviewing the next request.
      await loadCustomers();
      closeCustomerProfile();
      const who = person.business_name || person.name || 'Customer';
      if (result.welcomeEmail === 'sent') showToast(`${who} approved — confirmation email sent`);
      else if (customerCode) showToast(`${who} approved with code ${customerCode}`);
      else showToast(`${who} approved — allocate a code later to send the confirmation email`);
    } catch (err) {
      showToast(err.message || 'Approval failed', 'error');
    } finally { setSaving(''); }
  };

  const holdApplication = async (person) => {
    const reason = window.prompt(
      `Put ${person.business_name || person.name || person.email} on hold?\n\nOptional: enter what you still need or why you are waiting.`,
      person.application_hold_reason || '',
    );
    if (reason === null) return;
    setSaving(`hold-${person.id}`);
    try {
      await updateCustomerAdmin(person.id, {
        application_status: 'on_hold',
        application_hold_reason: reason.trim(),
      });
      await refreshPendingCount();
      await loadCustomers();
      closeCustomerProfile();
      showToast('Application moved to On Hold');
    } catch (err) {
      showToast(err.message || 'Could not put application on hold', 'error');
    } finally { setSaving(''); }
  };

  const returnApplicationToReview = async (person) => {
    setSaving(`review-${person.id}`);
    try {
      await updateCustomerAdmin(person.id, { application_status: 'pending' });
      await refreshPendingCount();
      setCustomerTab('requests');
      setCustomerPage(1);
      closeCustomerProfile();
      showToast('Application returned to Trade Requests');
    } catch (err) {
      showToast(err.message || 'Could not return application to review', 'error');
    } finally { setSaving(''); }
  };

  const removeCustomer = async (person, source = profileSource) => {
    if (!window.confirm(`Delete ${person.name || person.email}? This cannot be undone.`)) return;
    const savingKey = source === 'proto-active' ? `del-proto-${person.id}` : `del-${person.id}`;
    setSaving(savingKey);
    try {
      if (source === 'proto-active') {
        await deleteProtoActiveCustomer(person.id);
      } else {
        await deleteCustomer(person.id);
      }
      await loadCustomers();
      closeCustomerProfile();
      showToast('Customer removed');
    } catch (err) {
      if (err.code === 'has_orders') {
        const who = person.business_name || person.name || person.email;
        const n = err.orderCount || 0;
        showToast(
          `${who} has ${n === 1 ? 'an order' : `${n} orders`} on record, so the account can't be deleted. It stays listed with portal access off until you approve it again.`,
          'error',
        );
      } else {
        showToast(err.message || 'Delete failed', 'error');
      }
    } finally { setSaving(''); }
  };

  const deactivateCustomer = async (person) => {
    if (!window.confirm(`Deactivate ${person.name || person.email}? They will lose portal access, but their customer record and order history will be kept.`)) return;
    setSaving(`deact-${person.id}`);
    try {
      await updateCustomerAdmin(person.id, { is_approved: false, application_status: 'deactivated' });
      await loadCustomers();
      closeCustomerProfile();
      showToast('Customer deactivated');
    } catch (err) {
      showToast(err.message || 'Deactivate failed', 'error');
    } finally { setSaving(''); }
  };

  const downloadOrderFile = async (order) => {
    setSaving(`download-${order.id}`);
    try {
      const emailItems = buildEmailItemsFromOrder(order);
      const autoNotes = deriveAutoNotesFromItems(emailItems).join('\n');
      const { hasPrices, total, items: pdfItems } = resolveCustomerOrderPricing(emailItems);
      const pdfBase64 = await generateOrderPdfBase64({
        order,
        items: pdfItems,
        autoNotes,
        userNotes: order.order_change_notes || '',
        assignedTo: '',
        total,
        hasPrices,
        checkboxes: true,
      });
      const blob = base64ToBlob(pdfBase64, 'application/pdf');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `order-${order.order_number || order.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      showToast(err.message || 'Could not generate order PDF', 'error');
    } finally {
      setSaving('');
    }
  };

  const deleteOrder = async (order) => {
    const reason = window.prompt(`Move order ${order.order_number || order.id} to recoverable trash?\n\nEnter the reason (at least 8 characters):`);
    if (reason === null) return;
    if (reason.trim().length < 8) {
      showToast('Provide a deletion reason of at least 8 characters — nothing changed', 'error');
      return;
    }
    setSaving(`del-order-${order.id}`);
    try {
      await deleteOrderAdmin(order.id, reason);
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      // Keep the top stats bar in sync — drop the count immediately, then
      // reconcile with the server in the background.
      setStatsOrderTotal((n) => Math.max(0, n - 1));
      void refreshDashboardStats();
      showToast('Order moved to recoverable trash', 'success');
    } catch (err) {
      showToast(err.message || 'Could not move order to trash', 'error');
    } finally { setSaving(''); }
  };

  const updateOrder = async (order, patch) => {
    setSaving(order.id);
    try {
      const updated = await updateOrderAdmin(order.id, patch);
      setOrders((prev) => prev.map((item) => item.id === order.id ? updated : item));
      return updated;
    } catch (err) {
      showToast(err.message || 'Failed to update order', 'error');
      throw err;
    } finally { setSaving(''); }
  };

  const advanceOrderStatus = async (order, targetStatus) => {
    if ((targetStatus === 'payment received' || targetStatus === 'order sent') && !victorCanSend) {
      showToast(
        targetStatus === 'payment received' ? PAYMENT_RECEIVED_FORBIDDEN : CUSTOMER_SEND_FORBIDDEN,
        'error',
      );
      return;
    }
    setSaving(`advance-${order.id}`);
    try {
      const updated = await advanceOrderWorkflow(order.id, targetStatus, {
        senderUserId: activeFulfillmentUser?.id,
        senderName: activeFulfillmentUser?.name,
      });
      setOrders((prev) => prev.map((item) => item.id === order.id ? updated : item));
    } catch (err) {
      showToast(err.message || 'Could not update order status', 'error');
    } finally { setSaving(''); }
  };

  /**
   * One click from any stage to the Payment tab, so finished orders stop
   * cluttering the working tabs. "Payment received" is the only status the
   * Payment tab holds outright, so that is the target; the server walks the
   * intermediate stages itself (advanceOrderStatusToTarget).
   *
   * It is confirmed because the move cannot be undone — no route passes
   * `force`, and canAdvanceTo only ever steps forward, so a stray click on a
   * list row would otherwise strand an unpaid order as paid.
   */
  const markOrderCompleted = async (order) => {
    if (!victorCanSend) {
      showToast(PAYMENT_RECEIVED_FORBIDDEN, 'error');
      return;
    }
    const label = order.order_number || order.id;
    const confirmed = window.confirm(
      `Mark order ${label} as completed?\n\n`
      + 'This moves it to the Payment tab by setting its status to "payment received", '
      + 'which records the payment date.\n\n'
      + 'Orders only move forward, so this cannot be undone.',
    );
    if (!confirmed) return;
    await advanceOrderStatus(order, 'payment received');
  };

  const openFulfillment = (order) => {
    const items = (order.original_items || order.items || []).map((item) => ({
      ...item,
      checked: false,
      finalQty: item.qty,
    }));
    setFulfillmentOrder(order);
    setFulfillmentItems(items);
    setFulfillmentNotes(order.order_change_notes || '');
    setEditingItemIdx(null);
    setProductSwapSearch('');
    setProductSwapResults([]);
  };

  const closeFulfillment = () => {
    setFulfillmentOrder(null);
    setFulfillmentItems([]);
    setFulfillmentNotes('');
    setEditingItemIdx(null);
    setProductSwapSearch('');
    setProductSwapResults([]);
  };

  const handleSwapSearchChange = (q) => {
    setProductSwapSearch(q);
    clearTimeout(swapSearchTimerRef.current);
    if (!q.trim()) { setProductSwapResults([]); return; }
    swapSearchTimerRef.current = setTimeout(async () => {
      setProductSwapLoading(true);
      try {
        const data = await fetchAdminProductsPage({ page: 1, pageSize: 8, searchQuery: q });
        setProductSwapResults(data.rows);
      } finally { setProductSwapLoading(false); }
    }, 350);
  };

  const swapFulfillmentItem = (idx, product) => {
    setFulfillmentItems((prev) => prev.map((item, i) => i !== idx ? item : {
      ...item,
      productId: product.id,
      code: product.code,
      name: product.name,
      image: product.image || '',
      unitPrice: product.price,
    }));
    setEditingItemIdx(null);
    setProductSwapSearch('');
    setProductSwapResults([]);
  };

  const saveFulfillment = async () => {
    if (!fulfillmentOrder) return;
    setFulfillmentSaving(true);
    try {
      const finalItems = fulfillmentItems.map(({ checked, finalQty, ...rest }) => ({ ...rest, qty: finalQty }));
      await updateOrderAdmin(fulfillmentOrder.id, {
        final_items: finalItems,
        order_change_notes: fulfillmentNotes,
      });
      await advanceOrderWorkflow(fulfillmentOrder.id, 'order sent', {
        senderUserId: activeFulfillmentUser?.id,
        senderName: activeFulfillmentUser?.name,
      });
      await loadOrders();
      closeFulfillment();
      showToast('Order saved and moved to Order Confirmation');
    } catch (err) {
      showToast(err.message || 'Failed to save fulfillment', 'error');
    } finally { setFulfillmentSaving(false); }
  };

  const orderPages = Math.max(1, Math.ceil(orderTotal / orderPageSize));
  // True whenever the rows on screen are not the ones this tab/page asked for.
  const ordersPending = ordersLoadedKey !== `${orderTab}|${orderPage}|${orderPageSize}|${orderSearchDebounced}`;

  const customerPages = Math.max(1, Math.ceil(customerTotal / ADMIN_PAGE_SIZE));
  // Compact view: first rows only, with an explicit Show all / Minimise
  // toggle. Collapsing also returns to page 1 so the slice is never taken
  // from the middle of a paginated set.
  const visibleCustomerRows = customerListExpanded
    ? customerRows
    : customerRows.slice(0, COMPACT_CUSTOMER_ROWS);
  const toggleCustomerList = () => {
    setCustomerListExpanded((v) => {
      if (v) setCustomerPage(1);
      return !v;
    });
  };
  const fulfillmentNoteSections = buildOrderNoteSections({ userNotes: fulfillmentNotes });

  return (
    <div className="adm-shell">
      <a className="adm-skip-link" href="#admin-main">Skip to main content</a>
      {/* Fixed top loading indicator — doesn't disturb layout */}
      {(loadingProgress !== null || loading) && (
        <div className="adm-top-progress" role="progressbar" aria-label="Loading admin data" aria-valuemin="0" aria-valuemax="100" aria-valuenow={loadingProgress ?? 60}>
          <div className="adm-top-progress-fill" style={{ width: loadingProgress !== null ? `${loadingProgress}%` : '60%' }} />
        </div>
      )}
      <header className="adm-header">
        <div className="adm-header-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setSidebarOpen((s) => !s)} className="adm-hamburger" aria-label="Toggle menu">
              <Menu size={20} />
            </button>
            <div className="adm-brand">
              <strong>PROTO <span style={{ color: '#dc2626' }}>ADMIN</span></strong>
              <span className="adm-mobile-section-label">{activeSectionLabel}</span>
            </div>
          </div>
          <div className="adm-header-actions">
            <BridgeStatusDot />
            <LiveShoppersDot />
            <button type="button" onClick={goHome} className="adm-btn-ghost"><Home size={15} /><span className="adm-btn-text">Home</span></button>
            <button onClick={() => void refreshCurrentSection()} className="adm-btn-ghost"><RefreshCw size={15} /><span className="adm-btn-text">Refresh</span></button>
            <button onClick={onViewPortal} className="adm-btn-ghost"><ArrowLeftRight size={15} /><span className="adm-btn-text">Portal</span></button>
            {onSignOut && (
              <button type="button" onClick={onSignOut} className="adm-btn-ghost" title={customer?.email || 'Sign out'}>
                <Lock size={15} /><span className="adm-btn-text">Sign out</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="adm-body">
        <div className="adm-stats-bar">
          <AdminStat label="Live Products" value={stats.products} />
          <AdminStat label="Archived" value={stats.archived} />
          <AdminStat label="Customers" value={stats.customers} />
          <AdminStat label="Orders" value={stats.orders} />
        </div>

        <div className="adm-layout">
          {sidebarOpen && <button type="button" className="adm-sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close navigation menu" />}
          <aside className={`adm-sidebar${sidebarOpen ? ' adm-sidebar--open' : ''}`} aria-label="Admin navigation">
            <GroupedSidebar
          allowedSectionIds={allowedSectionIds}
              activeSection={activeSection}
              onSelectSection={(id) => {
                if (id === 'team') {
                  setFulfillmentSettingsOpen(true);
                  setSidebarOpen(false);
                  return;
                }
                setActiveSection(id);
                setLoadingError('');
                setSidebarOpen(false);
                if (id === 'catalogue' || id === 'reorder') {
                  window.scrollTo({ top: 0, behavior: 'instant' });
                }
              }}
              pendingCustomerCount={pendingCount}
              newOrdersCount={activeSection === 'orders' || newOrdersCount <= ordersBadgeSeen ? 0 : newOrdersCount}
            />
          </aside>

          <main id="admin-main" className="adm-main" tabIndex="-1">
            {loadingError && (
              <div style={{ margin: '12px 0', padding: '10px 16px', background: '#fef2f2', borderRadius: 8, color: '#c40000', fontSize: 13, fontWeight: 600 }}>
                Error: {loadingError}
              </div>
            )}

            <SectionErrorBoundary name="catalogue" title="Product Manager crashed" resetKey={activeSection}>
              <div style={{ display: activeSection === 'catalogue' || activeSection === 'to-order' ? 'block' : 'none' }}>
              <ProductManagerEngine
                taxonomyTree={taxonomyTree}
                onShowToast={showToast}
                onRefreshStats={refreshDashboardStats}
                initialStatus="live"
                initialToOrderOnly={activeSection === 'to-order'}
                initialSearch={activeSection === 'catalogue' ? productManagerSearch : ''}
                statuses={['live']}
                showCategorySidebar={activeSection !== 'to-order'}
                title={activeSection === 'to-order' ? 'To-order products' : 'Product Manager'}
                note={activeSection === 'to-order'
                  ? 'Every product customers can order when stock is unavailable. Search or edit a product, or use the amber To order button to remove it from this list.'
                  : undefined}
                onEditProduct={(item) => openEditProduct(item)}
                onEditCategory={setEditTaxonomyModal}
                onAddCategory={() => setNewCategoryModal({ label: '' })}
                onAddSubcategory={(parentId) => setNewSubModal({ parentId, label: '' })}
                onDeleteSubcategory={(sub) => void openDeleteSubcategory(sub)}
                onDeleteNode={(node) => void openDeleteSubcategory(node)}
                onRefreshTaxonomy={reloadTaxonomy}
                onCategoryReorder={handleCategoryReorder}
                categoryProductCounts={categoryProductCounts}
              />
              </div>
            </SectionErrorBoundary>

            {activeSection === 'hermes' && (
              <SectionErrorBoundary name="hermes" title="Hermes crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Hermes…" />}>
                  <HermesPanel onSelectSection={setActiveSection} />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {activeSection === 'product-intelligence' && (
              <SectionErrorBoundary name="product-intelligence" title="Product Intelligence crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Product Intelligence…" />}>
                  <ProductIntelligencePanel />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {activeSection === 'buying' && (
              <SectionErrorBoundary name="buying" title="Buying crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Buying…" />}>
                  <BuyingPanel onOpenProductIntelligence={() => setActiveSection('product-intelligence')} />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {/* Archived products — own top-level tab, same engine scoped to the archive. */}
            {activeSection === 'archive' && (
              <SectionErrorBoundary name="archive" title="Archive crashed" resetKey={activeSection}>
                <ProductManagerEngine
                  taxonomyTree={taxonomyTree}
                  onShowToast={showToast}
                  onRefreshStats={refreshDashboardStats}
                  initialStatus="archived"
                  statuses={['archived', 'recycle']}
                  showCategorySidebar={false}
                  title="Archive"
                  note="Archived products — set them live from here or fix codes/images before publishing."
                  onEditProduct={(item) => openEditProduct(item)}
                  onEditCategory={setEditTaxonomyModal}
                  onAddCategory={() => setNewCategoryModal({ label: '' })}
                  onAddSubcategory={(parentId) => setNewSubModal({ parentId, label: '' })}
                  onDeleteSubcategory={(sub) => void openDeleteSubcategory(sub)}
                  onDeleteNode={(node) => void openDeleteSubcategory(node)}
                  onRefreshTaxonomy={reloadTaxonomy}
                  onCategoryReorder={handleCategoryReorder}
                  categoryProductCounts={categoryProductCounts}
                />
              </SectionErrorBoundary>
            )}

            {activeSection === 'analytics' && (
              <SectionErrorBoundary name="analytics" title="Analytics crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Analytics…" />}>
                  <AnalyticsHub />
                </Suspense>
              </SectionErrorBoundary>
            )}


            {activeSection === 'backend-health' && (
              <SectionErrorBoundary name="backend-health" title="Backend Health crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Checking backend health…" />}>
                  <BackendHealthPanel />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {activeSection === 'product-loader' && (
              <SectionErrorBoundary name="product-loader" title="Product Loader crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Product Loader…" />}>
                <ProductLoaderPanel
                  taxonomyTree={taxonomyTree}
                  onShowToast={showToast}
                  initialCode={productLoaderCode}
                  onInitialCodeConsumed={() => setProductLoaderCode('')}
                  publishedBy={customer?.email || ''}
                  isOwner={customer?.role === 'owner'}
                  onOpenProductManager={openProductManagerForSku}
                  onOpenImageProcessing={customer?.role === 'owner' ? openImageProcessingCentre : undefined}
                />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {activeSection === 'image-processing' && (
              <SectionErrorBoundary name="image-processing" title="Image Processing Centre crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Image Processing Centre queue and image tools…" />}>
                  <ProductLoaderPanel
                    taxonomyTree={taxonomyTree}
                    onShowToast={showToast}
                    publishedBy={customer?.email || ''}
                    isOwner={customer?.role === 'owner'}
                    initialTab="image-processing"
                    onOpenProductManager={openProductManagerForSku}
                    onOpenNutstore={customer?.role === 'owner' ? openNutstore : undefined}
                    nutstoreSelection={imageProcessingHandoff.nutstoreSelection}
                    uploadSelection={imageProcessingHandoff.uploadSelection}
                    intakeOptions={imageProcessingIntake}
                    onIntakeOptionsChange={rememberImageProcessingIntake}
                    onNutstoreSelectionConsumed={consumeNutstoreHandoff}
                    onUploadSelectionConsumed={() => setImageProcessingHandoff((current) => ({ ...current, uploadSelection: [] }))}
                  />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {activeSection === 'title-replace' && (
              <SectionErrorBoundary name="title-replace" title="Title Replace crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Title Replace…" />}>
                  <BulkImageReplacePanel
                    taxonomyTree={taxonomyTree}
                    onShowToast={showToast}
                    titleOnly
                  />
                </Suspense>
              </SectionErrorBoundary>
            )}



            {/* FEATURED */}
            {/* SITE CONTENT — Featured, Specials and Banner Editor in one tab */}
            {activeSection === 'site-content' && (
              <SectionErrorBoundary name="site-content" title="Site Content crashed" resetKey={activeSection}>
                <div className="adm-panel">
                  <div className="adm-section-head">
                    <div>
                      <h2 className="adm-section-title">Site Content</h2>
                      <p className="adm-section-note">Featured products, weekly specials and the homepage banner — everything shown on the trade portal homepage.</p>
                    </div>
                  </div>
                  <div className="adm-customer-tabs" style={{ marginBottom: 16 }}>
                    <button type="button" onClick={() => setSiteContentTab('featured')} className={`adm-tab${siteContentTab === 'featured' ? ' adm-tab--active' : ''}`}>Featured</button>
                    <button type="button" onClick={() => setSiteContentTab('specials')} className={`adm-tab${siteContentTab === 'specials' ? ' adm-tab--active' : ''}`}>Specials</button>
                    <button type="button" onClick={() => setSiteContentTab('banner')} className={`adm-tab${siteContentTab === 'banner' ? ' adm-tab--active' : ''}`}>Banner Editor</button>
                  </div>
                  {siteContentTab === 'featured' && (
                    <Suspense fallback={<SectionSuspenseFallback label="Loading Featured…" />}>
                      <FeaturedPanel taxonomyTree={taxonomyTree} onShowToast={showToast} />
                    </Suspense>
                  )}
                  {siteContentTab === 'specials' && (
                    <Suspense fallback={<SectionSuspenseFallback label="Loading Specials…" />}>
                      <SpecialsPanel specials={specials} onSpecialsChange={setSpecials} onShowToast={showToast} />
                    </Suspense>
                  )}
                  {siteContentTab === 'banner' && (
                    <Suspense fallback={<SectionSuspenseFallback label="Loading Banner Editor…" />}>
                      <BannerPanel onShowToast={showToast} />
                    </Suspense>
                  )}
                </div>
              </SectionErrorBoundary>
            )}



            {/* REORDER */}
            {activeSection === 'reorder' && (
              <SectionErrorBoundary name="reorder" title="Reorder Grid crashed" resetKey={activeSection}>
                <Suspense fallback={<SectionSuspenseFallback label="Loading Reorder Grid…" />}>
                <ReorderPanel
                  ref={reorderPanelRef}
                  isActive={activeSection === 'reorder'}
                  taxonomyTree={taxonomyTree}
                  categoryProductCounts={categoryProductCounts}
                  onCategoryReorder={handleCategoryReorder}
                  onEditSubcategory={setEditTaxonomyModal}
                  onDeleteSubcategory={(sub) => void openDeleteSubcategory(sub)}
                  onAddSubcategory={(parentId) => setNewSubModal({ parentId, label: '' })}
                  onEditProduct={openContentEdit}
                  onShowToast={showToast}
                  onRefreshStats={refreshDashboardStats}
                  onRefreshCategoryCounts={reloadTaxonomy}
                />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {/* CUSTOMERS */}
            {activeSection === 'customers' && (
              <SectionErrorBoundary name="customers" title="Customer Management crashed" resetKey={activeSection}>
              <div className="adm-panel">
                <div className="adm-section-head">
                  <div>
                    <h2 className="adm-section-title">Customer Management</h2>
                    <p className="adm-section-note">
                      Review trade applications, manage pre-registration contacts for CRM email, and approved trade portal accounts.
                    </p>
                  </div>
                  <div className="adm-customer-actions">
                    <input
                      ref={customerCsvRef}
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      hidden
                      onChange={(e) => { void handleCustomerCsvUpload(e.target.files?.[0]); e.target.value = ''; }}
                    />
                    {/* Primary actions stay one-click; infrequent data/utility
                        actions move into a tidy overflow menu. */}
                    <ActionMenu
                      items={[
                        {
                          label: importingCustomers ? 'Importing…' : 'Upload CSV',
                          icon: importingCustomers ? <Loader2 size={14} className="spin" /> : <Upload size={14} />,
                          disabled: importingCustomers,
                          onClick: () => customerCsvRef.current?.click(),
                        },
                        {
                          label: exportingCustomers ? 'Exporting…' : 'Export all customers',
                          icon: exportingCustomers ? <Loader2 size={14} className="spin" /> : <Download size={14} />,
                          disabled: exportingCustomers,
                          onClick: () => void handleExportAllCustomers(),
                        },
                        {
                          label: 'Delete all pre-registration',
                          icon: <Trash2 size={14} />,
                          danger: true,
                          disabled: saving === 'del-all-proto',
                          onClick: () => void handleDeleteAllProtoActive(),
                        },
                      ]}
                    />
                    <button type="button" className="adm-btn-ghost" onClick={() => setAddCustomerOpen(true)} title="Manually add a customer into a chosen section">
                      <UserPlus size={14} /> Add customer
                    </button>
                    <button type="button" className="adm-btn-red" onClick={() => { setComposeTarget(null); setCustomerEmailOpen(true); }}>
                      <Mail size={14} /> Send email
                    </button>
                  </div>
                </div>

                <div className="adm-customer-tabs">
                  <button onClick={() => setCustomerTab('requests')} className={`adm-tab${customerTab === 'requests' ? ' adm-tab--active' : ''}`}>Trade Requests</button>
                  <button onClick={() => setCustomerTab('on-hold')} className={`adm-tab${customerTab === 'on-hold' ? ' adm-tab--active' : ''}`}>On Hold</button>
                  {/* Pre-registration is database-only by request. The contacts
                      are still imported, tagged, grouped and emailable from the
                      composer's Audience list — they are simply not browsed here. */}
                  <button onClick={() => setCustomerTab('regular')} className={`adm-tab${customerTab === 'regular' ? ' adm-tab--active' : ''}`}>Approved</button>
                  <label className="adm-search adm-search--inline"><Search size={14} /><input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Search…" className="adm-search-input" /></label>
                  {customerTab !== 'proto-active' && (
                    <AdminSelect
                      ariaLabel="Filter by business type"
                      value={customerBusinessType}
                      onChange={setCustomerBusinessType}
                      options={[
                        { value: '', label: 'All business types' },
                        { value: '__unspecified__', label: 'Unspecified' },
                        ...BUSINESS_TYPES.map((type) => ({ value: type, label: type })),
                      ]}
                    />
                  )}
                </div>

                {customerTab === 'proto-active' && (
                  <>
                    {customerBatches.length > 0 && (
                      <div className="adm-toolbar" style={{ gridTemplateColumns: 'minmax(0, 320px)' }}>
                        <AdminSelect
                          value={customerBatch}
                          onChange={setCustomerBatch}
                          options={[
                            { value: '', label: `All uploads — ${customerBatches.reduce((n, b) => n + b.count, 0)} contacts` },
                            ...customerBatches.map((b) => ({
                              value: b.label,
                              label: `${b.label} — ${b.count} contact${b.count === 1 ? '' : 's'}`,
                            })),
                          ]}
                        />
                      </div>
                    )}
                    <p className="adm-muted adm-tab-helper">
                      Contacts for CRM email campaigns before trade portal approval.
                      {customerBatch ? ` Showing the ${customerBatch} upload only.` : ''}
                    </p>
                  </>
                )}

                {customerTab === 'proto-active' ? (
                  <div className="adm-list">
                    <div className="adm-list-head" style={{ gridTemplateColumns: '80px 1.2fr 110px 90px 1.1fr 100px 80px 100px 120px' }}>
                      <span>Code</span><span>Business</span><span>Contact</span><span>First name</span><span>Email</span><span>{POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} Sales</span><span>Invoices</span><span>Last purchase</span><span>Actions</span>
                    </div>
                    {customerRows.length === 0 && !loading && (
                      <div className="adm-empty" style={{ padding: '24px 0' }}>
                        No pre-registration contacts in this list yet.
                      </div>
                    )}
                    {visibleCustomerRows.map((row) => (
                      <div key={row.id || row.email} className="adm-list-row" style={{ gridTemplateColumns: '80px 1.2fr 110px 90px 1.1fr 100px 80px 100px 120px', alignItems: 'center' }}>
                        <span data-label="Code" style={{ fontWeight: 800, fontFamily: 'monospace' }}>{row.account_code}</span>
                        <span data-label="Business" style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</span>
                        <input
                          type="text"
                          className="adm-tiny-input"
                          data-label="Contact"
                          defaultValue={row.contact_name || ''}
                          placeholder="Contact name"
                          disabled={protoNameSaving === `${row.id}-contact_name`}
                          onBlur={(e) => void saveProtoActiveName(row, 'contact_name', e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                          style={{ width: '100%', fontSize: 12, borderColor: row.contact_name ? undefined : '#fca5a5' }}
                          aria-label={`Contact name for ${row.email}`}
                        />
                        <input
                          type="text"
                          className="adm-tiny-input"
                          data-label="First name"
                          defaultValue={row.first_name || ''}
                          placeholder="First name"
                          disabled={protoNameSaving === `${row.id}-first_name`}
                          onBlur={(e) => void saveProtoActiveName(row, 'first_name', e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                          style={{ width: '100%', fontSize: 12, fontWeight: 600, borderColor: row.first_name ? undefined : '#fca5a5' }}
                          aria-label={`First name for ${row.email}`}
                        />
                        <span data-label="Email" style={{ fontSize: 12 }}>{row.email}</span>
                        <span data-label={`${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} Sales`} style={{ fontSize: 12 }}>R{Number(row.sales_last_12_months || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</span>
                        <span data-label="Invoices" style={{ fontSize: 12 }}>{row.invoice_count ?? '—'}</span>
                        <span data-label="Last purchase" style={{ fontSize: 11, color: '#6b7280' }}>{row.last_purchase_date ? new Date(row.last_purchase_date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
                        <div data-cell="actions" style={{ display: 'flex', gap: 5 }}>
                          <button type="button" className="adm-btn-ghost adm-btn-sm" style={{ padding: '4px 9px', fontSize: 11 }} onClick={() => openCustomerProfile(row, 'proto-active')}>Edit</button>
                          <button type="button" className="adm-btn-ghost adm-btn-sm" style={{ padding: '4px 7px', color: '#c40000' }} disabled={saving === `del-proto-${row.id}`} onClick={() => void removeProtoActiveCustomer(row)}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : customerTab === 'requests' || customerTab === 'on-hold' ? (
                  <div className="adm-list">
                    <div className="adm-list-head" style={{ gridTemplateColumns: '1.4fr 1fr 0.9fr 1.3fr 0.8fr 90px 200px' }}>
                      <span>Business Name</span><span>Location</span><span>Date Applied</span><span>Email / Phone</span><span>Whatsapp</span><span>Code</span><span>Actions</span>
                    </div>
                    {customerRows.length === 0 && !loading && (
                      <div className="adm-empty" style={{ padding: '24px 0' }}>
                        {customerTab === 'on-hold' ? 'No applications are on hold.' : 'No pending trade requests.'}
                      </div>
                    )}
                    {visibleCustomerRows.map((person) => (
                      <div key={person.id} className="adm-list-row" style={{ gridTemplateColumns: '1.4fr 1fr 0.9fr 1.3fr 0.8fr 90px 200px', alignItems: 'center' }}>
                        <div data-label="Business">
                          <div style={{ fontWeight: 700, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {person.business_name || person.name || 'Unknown'}
                            {person.accept_whatsapp === true && (
                              <Check size={14} color="#15803d" strokeWidth={3} aria-label="WhatsApp opted in" />
                            )}
                            <TenThousandClubBadge customer={person} />
                            <LastEmailBadge customer={person} />
                          </div>
                          <div className="adm-muted" style={{ fontSize: 11 }}>{person.name}{person.business_type ? ` · ${person.business_type}` : ''}</div>
                        </div>
                        <div data-label="Location" style={{ fontSize: 12 }}>{[person.city, person.province, person.country].filter(Boolean).join(', ') || '—'}</div>
                        <div data-label="Applied" style={{ fontSize: 11, color: '#6b7280' }}>{new Date(person.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                        <div data-label="Contact">
                          <div style={{ fontSize: 12 }}>{person.email}</div>
                          <div className="adm-muted" style={{ fontSize: 11 }}>{person.phone || '—'}</div>
                        </div>
                        <div data-label="WhatsApp"><WhatsappOptIn value={person.accept_whatsapp} /></div>
                        <div data-label="Code">
                          <input
                            type="text"
                            className="adm-tiny-input"
                            placeholder="Code (opt.)"
                            maxLength={6}
                            value={approvalCodes[person.id] || ''}
                            onChange={(e) => setApprovalCodes((prev) => ({
                              ...prev,
                              [person.id]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
                            }))}
                            title="Optional. A code sends the confirmation email now; leave blank to allocate later."
                            style={{ width: '84px', fontFamily: 'monospace', fontWeight: 700 }}
                            aria-label={`Customer code for ${person.email}`}
                          />
                        </div>
                        <div data-cell="actions" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button onClick={() => void openCustomerProfile(person)} className="adm-btn-ghost adm-btn-sm" style={{ padding: '4px 9px', fontSize: 11 }}>View details</button>
                          {customerTab === 'on-hold' ? (
                            <button onClick={() => void returnApplicationToReview(person)} className="adm-btn-ghost adm-btn-sm" disabled={saving === `review-${person.id}`}>
                              {saving === `review-${person.id}` ? '…' : 'Return to review'}
                            </button>
                          ) : (
                            <button onClick={() => void holdApplication(person)} className="adm-btn-ghost adm-btn-sm" disabled={saving === `hold-${person.id}`}>
                              {saving === `hold-${person.id}` ? '…' : <><PauseCircle size={12} /> Put on hold</>}
                            </button>
                          )}
                          <button
                            onClick={() => void approveRequest(person)}
                            className="adm-btn-green adm-btn-sm"
                            disabled={saving === person.id
                              || (!!approvalCodes[person.id] && !/^[A-Z0-9]{6}$/.test(approvalCodes[person.id]))}
                          >
                            {saving === person.id ? '…' : <><Check size={12} /> Approve</>}
                          </button>
                          <button onClick={() => void removeCustomer(person)} className="adm-btn-ghost adm-btn-sm" style={{ padding: '4px 7px', color: '#c40000' }} disabled={saving === `del-${person.id}`}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="adm-list">
                    <div className="adm-list-head" style={{ gridTemplateColumns: '80px 1.1fr 1.1fr 1fr 80px 70px 90px' }}>
                      <span>Code</span><span>Name</span><span>Email</span><span>Phone</span><span>WhatsApp</span><span>Orders</span><span></span>
                    </div>
                    {customerRows.length === 0 && !loading && (
                      <div className="adm-empty" style={{ padding: '24px 0' }}>No approved customers yet.</div>
                    )}
                    {visibleCustomerRows.map((person) => (
                      <div key={person.id} className="adm-list-row" style={{ gridTemplateColumns: '80px 1.1fr 1.1fr 1fr 80px 70px 90px' }}>
                        <span data-label="Code" style={{ fontWeight: 800, fontFamily: 'monospace', fontSize: 12 }}>{person.customer_code || '—'}</span>
                        <div data-label="Name">
                          <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {person.name || person.business_name || 'Unnamed'}
                            {person.accept_whatsapp === true && (
                              <Check size={14} color="#15803d" strokeWidth={3} aria-label="WhatsApp opted in" />
                            )}
                            <TenThousandClubBadge customer={person} />
                            <LastEmailBadge customer={person} />
                          </span>
                          {(person.first_name || person.contact_name) && (
                            <div className="adm-muted" style={{ fontSize: 11 }}>
                              {[person.first_name, person.contact_name && person.contact_name !== person.name ? person.contact_name : null].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </div>
                        <span data-label="Email" style={{ fontSize: 13 }}>{person.email}</span>
                        <span data-label="Phone" style={{ fontSize: 13 }}>{person.phone || '—'}</span>
                        <span data-label="WhatsApp"><WhatsappOptIn value={person.accept_whatsapp} /></span>
                        <span data-label="Orders">{person.orderCount}</span>
                        <div data-cell="actions" style={{ display: 'flex', gap: 5 }}>
                          <button onClick={() => void openCustomerProfile(person)} className="adm-btn-ghost adm-btn-sm" style={{ padding: '4px 9px', fontSize: 11 }}>View details</button>
                          <button onClick={() => void removeCustomer(person)} className="adm-btn-ghost adm-btn-sm" disabled={saving === `del-${person.id}`} style={{ color: '#c40000', padding: '4px 8px' }}>
                            {saving === `del-${person.id}` ? '…' : <X size={14} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {customerTotal > COMPACT_CUSTOMER_ROWS && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 2px' }}>
                    <button
                      type="button"
                      className="adm-btn-ghost"
                      onClick={toggleCustomerList}
                      style={{ fontWeight: 700, fontSize: 13 }}
                    >
                      {customerListExpanded
                        ? 'Minimise list'
                        : `Show all ${customerTotal} ${customerTab === 'requests' ? 'trade requests' : 'customers'}`}
                    </button>
                  </div>
                )}
                {customerListExpanded && (
                  <Pager page={customerPage} totalPages={customerPages} onChange={setCustomerPage} />
                )}
              </div>
              </SectionErrorBoundary>
            )}

            {/* PRICING */}
            {activeSection === 'pricing' && (
              <SectionErrorBoundary name="pricing" title="Pricing crashed" resetKey={activeSection}>
                <Suspense fallback={<SectionSuspenseFallback label="Loading Pricing…" />}>
                  <PricingPanel
                    taxonomyTree={taxonomyTree}
                    specials={specials}
                    onSpecialsChange={setSpecials}
                    onShowToast={showToast}
                  />
                </Suspense>
              </SectionErrorBoundary>
            )}

            {/* ORDERS */}
            {activeSection === 'orders' && (
              <SectionErrorBoundary name="orders" title="Order Requests crashed" resetKey={activeSection}>
              <div className="adm-panel">
                <div className="adm-section-head">
                  <div>
                    <h2 className="adm-section-title">Order Requests</h2>
                    <p className="adm-section-note">
                      Paginated order list with server-side search and tab filters. Click a row to expand details.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="adm-search"><Search size={15} /><input value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} placeholder="Search orders" className="adm-search-input" /></label>
                    <button
                      type="button"
                      className={`adm-btn-ghost${orderWorkspaceOpen ? ' adm-tab--active' : ''}`}
                      aria-expanded={orderWorkspaceOpen}
                      onClick={() => setOrderWorkspaceOpen((v) => !v)}
                      title="Open the order-building workspace (drafts, customer context, reminders)"
                    >
                      <ClipboardList size={15} />
                      <span className="adm-btn-text">Order Workspace</span>
                      {orderWorkspaceOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>
                </div>

                <NotificationQueueHealth />

                {(
                <>
                <div className="adm-order-tabs">
                  {ORDER_TAB_DEFS.map(({ key, label, overview }) => {
                    const count = orderTabCounts?.[key] ?? (key === 'all'
                      ? orderTabCounts?.all ?? orderTotal
                      : 0);
                    const isActive = orderTab === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => { setOrderTab(key); setOrderPage(1); }}
                        className={[
                          'adm-order-tab',
                          isActive ? 'adm-order-tab--active' : '',
                          overview ? 'adm-order-tab--overview' : '',
                          isActive && overview ? 'adm-order-tab--overview-active' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        {label}
                        {count > 0 && (
                          <span className={[
                            'adm-order-tab-count',
                            overview ? 'adm-order-tab-count--muted' : '',
                            isActive && !overview ? 'adm-order-tab-count--on-dark' : '',
                          ].filter(Boolean).join(' ')}>
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {orderTab === 'all' && (
                  <p className="adm-muted adm-tab-helper">
                    Overview only — new orders always start in <strong>New</strong>. Use the workflow tabs above for day-to-day work.
                  </p>
                )}
                {orderTab === 'paid' && (
                  <p className="adm-muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
                    Payment tab includes sent confirmations awaiting payment.
                  </p>
                )}
                <div className="adm-list">
                  <div className="adm-list-head" style={{ gridTemplateColumns: orderListGridCols }}>
                    <span>Order</span><span>Customer</span><span>Date & Time</span><span>Amount</span><span>{orderTab === 'sent' ? 'Order Confirmation' : orderTab === 'paid' ? 'Payment' : 'Status'}</span><span>Actions</span><span></span>
                  </div>
                  {orderRows.map((order) => {
                    const isExpanded = expandedOrderId === order.id;
                    const dt = new Date(order.created_at);
                    const dateStr = dt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
                    const timeStr = dt.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
                    const isPreSale = normalizeOrderStatus(order.status) === 'order sent';
                    return (
                      <div key={order.id}>
                        {order.__pinned && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px 8px 0 0', color: '#78350f', fontSize: 12, fontWeight: 600 }}>
                            Picking started, so this order advanced out of the {'\u201C'}{ORDER_TAB_LABELS[orderTab] || orderTab}{'\u201D'} tab.
                            It stays here while open {'\u2014'} find it under its new status tab afterwards.
                          </div>
                        )}
                        <div
                          className={`adm-list-row adm-order-row${focusOrderId === order.id ? ' adm-order-row--focus' : ''}`}
                          style={{ gridTemplateColumns: orderListGridCols, cursor: 'pointer' }}
                          data-order-id={order.id}
                          onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                        >
                          <div data-label="Order">
                            <div style={{ fontWeight: 800, fontSize: 13 }}>{displayOrderNumber(order)}</div>
                          </div>
                          <div data-label="Customer">
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{order.customers?.name || 'Unknown'}</div>
                            <div className="adm-muted" style={{ fontSize: 11 }}>{order.customers?.email || ''}</div>
                          </div>
                          <div data-label="Date">
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{dateStr}</div>
                            <div className="adm-muted" style={{ fontSize: 11 }}>{timeStr}</div>
                          </div>
                          <div data-label="Amount">
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{formatRandAmount(orderAmountExVat(order))}</div>
                            <div className="adm-muted" style={{ fontSize: 11 }}>ex VAT</div>
                            {(() => {
                              const promo = orderPromo(order);
                              if (!promo) return null;
                              return (
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', marginTop: 2 }}>
                                  {promo.code}{promo.discountPct != null ? ` −${promo.discountPct}%` : ''}
                                </div>
                              );
                            })()}
                          </div>
                          <div data-label="Status" onClick={(e) => e.stopPropagation()} className="adm-presale-col">
                            {orderTab === 'sent' && isPreSale ? (
                              renderOrderConfirmationActions(order)
                            ) : orderTab === 'paid' ? (
                              renderPaymentActions(order) || <OrderWorkflowBadge order={order} />
                            ) : (
                              <OrderWorkflowBadge order={order} />
                            )}
                            {teamWaSent[order.id]?.sentAt && (
                              <span
                                className="adm-wa-sent-tag"
                                title={`WhatsApp sent to the team${teamWaSent[order.id].by ? ` by ${teamWaSent[order.id].by}` : ''}`}
                              >
                                Sent over
                              </span>
                            )}
                          </div>
                          <div data-cell="actions" style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                            {orderTab === 'handed' && (
                              <button
                                onClick={() => void sendTeamWhatsapp(order)}
                                disabled={saving === `wa-${order.id}`}
                                className="adm-icon-btn"
                                style={{ color: '#15803d' }}
                                title={teamWaSent[order.id]?.sentAt ? 'Send the team WhatsApp again' : 'WhatsApp this order to the team'}
                              >
                                {saving === `wa-${order.id}` ? <Loader2 size={14} className="spin" /> : <MessageCircle size={14} />}
                              </button>
                            )}
                            {showMarkCompleted && normalizeOrderStatus(order.status) !== 'payment received' && (
                              <button
                                type="button"
                                onClick={() => void markOrderCompleted(order)}
                                disabled={saving === `advance-${order.id}`}
                                className="adm-btn-ghost adm-mark-complete"
                                title="Move this order to the Payment tab"
                              >
                                {saving === `advance-${order.id}`
                                  ? <Loader2 size={14} className="spin" />
                                  : <CheckCircle size={14} />}
                                Mark as completed
                              </button>
                            )}
                            <button onClick={() => window.open(`/fulfillment?id=${order.id}`, '_blank')} className="adm-icon-btn" title="Fulfil order (opens in new tab)" style={{ color: '#15803d' }}><ClipboardList size={14} /></button>
                            <button onClick={() => void downloadOrderFile(order)} disabled={saving === `download-${order.id}`} className="adm-icon-btn" title="Download order PDF">{saving === `download-${order.id}` ? <Loader2 size={14} className="spin" /> : <FileDown size={14} />}</button>
                            {orderTrashEnabled && (
                              <button onClick={() => void deleteOrder(order)} className="adm-icon-btn" style={{ color: '#c40000' }} disabled={saving === `del-order-${order.id}`} title="Move order to recoverable trash">
                                {saving === `del-order-${order.id}` ? '…' : <Trash2 size={14} />}
                              </button>
                            )}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <span className="adm-muted" style={{ fontSize: 18, lineHeight: 1 }}>{isExpanded ? '↑' : '↓'}</span>
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{ background: '#f8fafc', borderTop: '1px solid #f1f5f9', padding: '14px 16px' }}>
                            <div style={{ marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                              <OrderWorkflowBadge order={order} />
                              {getWorkflowAdvanceOptions(order.status).map(({ label, target }) => (
                                <button
                                  key={target}
                                  type="button"
                                  className="adm-btn-ghost"
                                  style={{ fontSize: 12, padding: '4px 10px' }}
                                  disabled={saving === `advance-${order.id}`}
                                  onClick={() => void advanceOrderStatus(order, target)}
                                >
                                  {saving === `advance-${order.id}` ? 'Updating…' : label}
                                </button>
                              ))}
                            </div>
                            <OrderEmailNotify orderId={order.id} orderStatus={normalizeOrderStatus(order.status)} />
                            {(() => {
                              const promo = orderPromo(order);
                              if (!promo) return null;
                              const gross = orderAmountExVat(order);
                              const net = promo.discountAmount != null ? Math.max(0, gross - promo.discountAmount) : null;
                              return (
                                <div style={{ margin: '0 0 14px', padding: '10px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
                                  <span style={{ fontSize: 12, fontWeight: 800, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Promo applied</span>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
                                    {promo.code}{promo.discountPct != null ? ` · ${promo.discountPct}% off` : ''}
                                  </span>
                                  {promo.discountAmount != null && (
                                    <span style={{ fontSize: 13, color: '#166534' }}>Discount −{formatRandAmount(promo.discountAmount)}</span>
                                  )}
                                  {net != null && (
                                    <span style={{ fontSize: 13, color: '#166534' }}>Est. net {formatRandAmount(net)} <span style={{ color: '#4d7c5a' }}>ex VAT</span></span>
                                  )}
                                </div>
                              );
                            })()}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                              <OrderItemsList label="Order placed" items={order.original_items || order.items || []} />
                              <OrderItemsList label="Order final" items={order.final_items || order.items || []} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {ordersPending && orderRows.length === 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
                      <Loader2 size={16} className="spin" /> Loading orders…
                    </div>
                  )}
                  {!ordersPending && orderRows.length === 0 && (
                    <div style={{ padding: '20px 16px', color: '#6b7280', fontSize: 13 }}>
                      {orderSearch ? 'No orders match your search.' : orderTab === 'all' ? 'No orders yet.' : `No orders in this tab.`}
                    </div>
                  )}
                </div>
                <div className="adm-orders-pagebar">
                  <label className="oa-select-wrap">
                    Show
                    <select
                      value={orderPageSize}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setOrderPageSize(next);
                        try { localStorage.setItem('adm-orders-page-size', String(next)); } catch { /* ignore */ }
                      }}
                    >
                      {ORDER_PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>{size} orders</option>
                      ))}
                    </select>
                  </label>
                  <span className="adm-orders-pagebar__count">
                    {orderTotal > 0 && (
                      <>
                        {(orderPage - 1) * orderPageSize + 1}–{Math.min(orderPage * orderPageSize, orderTotal)} of {orderTotal}
                      </>
                    )}
                  </span>
                  {orderPages > 1 && (
                    <Pager page={orderPage} totalPages={orderPages} onChange={setOrderPage} />
                  )}
                </div>
                </>
                )}
              </div>
              {orderWorkspaceOpen && (
                <Suspense fallback={<LazySectionFallback label="Loading Order Workspace…" />}>
                  <OrdersWorkspacePanel
                    initialWorkspaceId={initialOrderWorkspaceId}
                    onShowToast={showToast}
                  />
                </Suspense>
              )}
              </SectionErrorBoundary>
            )}

            {/* EMAIL CRM — contacts + composer + campaign analytics in one place */}
            {activeSection === 'comms' && (
              <SectionErrorBoundary name="comms" title="Email CRM crashed" resetKey={activeSection}>
                <Suspense fallback={<LazySectionFallback label="Loading Email CRM…" />}>
                  <CommsPanel
                    onCompose={(target) => { setComposeTarget(target || null); setCustomerEmailOpen(true); }}
                    onShowToast={showToast}
                  />
                </Suspense>
              </SectionErrorBoundary>
            )}


            {/* BANNER EDITOR + POPUP SPECIALS — merged into the Site Content tab */}


          </main>
        </div>
      </div>

      {/* Customer profile drawer */}
      {profileCustomer && (
        <div className="adm-drawer-backdrop" onClick={closeCustomerProfile} onKeyDown={(event) => { if (event.key === 'Escape') closeCustomerProfile(); }}>
          <div className="adm-drawer adm-drawer--intelligence" role="dialog" aria-modal="true" aria-labelledby="customer-profile-heading" onClick={(e) => e.stopPropagation()}>
            <div className="adm-drawer-head">
              <h3 id="customer-profile-heading">Customer Intelligence</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!profileEditing && (
                  <button onClick={startEditProfile} className="adm-btn-ghost adm-btn-sm">Edit</button>
                )}
                <button onClick={closeCustomerProfile} className="adm-icon-btn" aria-label="Close customer intelligence"><X size={16} /></button>
              </div>
            </div>
            <div className="adm-drawer-body">
              <CustomerIntelligenceWorkspace
                customer={profileCustomer}
                orders={profileOrders}
                totalOrders={profileOrdersTotal}
                source={profileSource}
                loading={profileOrdersLoading}
                loadError={profileOrdersError}
                onRetry={() => void openCustomerProfile(profileCustomer, profileSource)}
                headerBadges={<><TenThousandClubBadge customer={profileCustomer} /><LastEmailBadge customer={profileCustomer} /></>}
              />

              {profileEditing ? (
                <div style={{ display: 'grid', gap: 12, marginTop: 4 }}>
                  {profileSource === 'proto-active' ? (
                    <>
                      {[
                        ['Account code', 'account_code', 'text'],
                        ['Business name', 'business_name', 'text'],
                        ['Email', 'email', 'email'],
                        ['Contact name', 'contact_name', 'text'],
                        ['First name', 'first_name', 'text'],
                      ].map(([label, key, type]) => (
                        <div key={key}>
                          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
                          <input className="adm-field-input" type={type} value={profileForm[key] || ''} onChange={setPf(key)} style={{ width: '100%' }} />
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      {[
                        ['Contact person', 'name', 'text'],
                        ['Email', 'email', 'email'],
                        ['Phone', 'phone', 'tel'],
                        ['Business name', 'business_name', 'text'],
                        ['Business type', 'business_type', 'text'],
                        ['VAT number', 'vat_number', 'text'],
                        ['Website / social', 'website', 'text'],
                      ].map(([label, key, type]) => (
                        <div key={key}>
                          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
                          <input className="adm-field-input" type={type} value={profileForm[key] || ''} onChange={setPf(key)} style={{ width: '100%' }} />
                        </div>
                      ))}
                      <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Customer code</label>
                        <input
                          className="adm-field-input"
                          value={profileForm.customer_code || ''}
                          onChange={(e) => setProfileForm((f) => ({ ...f, customer_code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }))}
                          placeholder="6-character code"
                          maxLength={6}
                          style={{ width: '100%', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em' }}
                        />
                        <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          {profileCustomer.customer_code
                            ? 'A code is already set. Changing it will not resend the email.'
                            : 'Leave blank to allocate later. Saving a code sends the confirmation email.'}
                        </span>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Monthly spend</label>
                        <select className="adm-field-input" value={profileForm.monthly_spend || ''} onChange={setPf('monthly_spend')} style={{ width: '100%' }}>
                          <option value="">—</option>
                          {SPEND_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                      {[['Company address', 'company_address'], ['Delivery address', 'delivery_address']].map(([label, key]) => (
                        <div key={key}>
                          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
                          <textarea className="adm-field-input" rows={2} value={profileForm[key] || ''} onChange={setPf(key)} style={{ width: '100%', resize: 'vertical' }} />
                        </div>
                      ))}
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button className="adm-btn-green" onClick={() => void saveProfileEdit()} disabled={savingProfile}>{savingProfile ? 'Saving…' : 'Save changes'}</button>
                    <button className="adm-btn-ghost" onClick={() => setProfileEditing(false)} disabled={savingProfile}>Cancel</button>
                  </div>
                </div>
              ) : (
                <section className="adm-account-details" aria-labelledby="customer-account-heading">
                  <h3 id="customer-account-heading">Current account details</h3>
                  <div className="adm-drawer-fields">
                  <DrawerField icon={User} label="Contact person" value={profileCustomer.contact_name || profileCustomer.name} />
                  <DrawerField icon={Mail} label="Email" value={profileCustomer.email} />
                  {profileSource !== 'proto-active' && <DrawerField icon={Phone} label="Phone" value={profileCustomer.phone} />}
                  <DrawerField icon={Building2} label="Customer code" value={profileCustomer.customer_code || profileCustomer.account_code} />
                  {profileCustomer.first_name && <DrawerField icon={User} label="First name" value={profileCustomer.first_name} />}
                  {profileCustomer.sales_last_12_months != null && (
                    <DrawerField icon={Store} label={`${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} sales (${POSITILL_CUSTOMER_SALES_PERIOD.taxBasis})`} value={`R${Number(profileCustomer.sales_last_12_months).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`} />
                  )}
                  {profileCustomer.invoice_count != null && (
                    <DrawerField icon={Store} label={`${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} invoices`} value={String(profileCustomer.invoice_count)} />
                  )}
                  {profileSource === 'proto-active' && (
                    <DrawerField icon={Building2} label="Sales period" value={`${POSITILL_CUSTOMER_SALES_PERIOD.start} – ${POSITILL_CUSTOMER_SALES_PERIOD.end} · imported snapshot`} />
                  )}
                  {profileCustomer.last_purchase_date && (
                    <DrawerField icon={Building2} label="Last purchase" value={new Date(profileCustomer.last_purchase_date).toLocaleDateString('en-ZA')} />
                  )}
                  </div>
                </section>
              )}

            </div>
            <div className="adm-drawer-footer">
              <button onClick={closeCustomerProfile} className="adm-btn-ghost">Close</button>
              {profileSource !== 'proto-active' && !profileCustomer.is_approved && (
                <>
                  <input
                    type="text"
                    className="adm-tiny-input"
                    placeholder="Code (optional)"
                    maxLength={6}
                    value={approvalCodes[profileCustomer.id] || ''}
                    onChange={(e) => setApprovalCodes((prev) => ({
                      ...prev,
                      [profileCustomer.id]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
                    }))}
                    title="Optional. Type a 6-character code to send the confirmation email now, or leave blank and allocate it later."
                    style={{ width: 108, fontFamily: 'monospace', fontWeight: 700 }}
                  />
                  <button
                    onClick={() => void approveRequest(profileCustomer)}
                    className="adm-btn-green"
                    disabled={saving === profileCustomer.id
                      || (!!approvalCodes[profileCustomer.id] && !/^[A-Z0-9]{6}$/.test(approvalCodes[profileCustomer.id]))}
                  >
                    {saving === profileCustomer.id ? 'Approving…' : <><Check size={15} /> Approve</>}
                  </button>
                </>
              )}
              {profileSource !== 'proto-active' && !profileCustomer.is_approved && profileCustomer.application_status !== 'on_hold' && (
                <button onClick={() => void holdApplication(profileCustomer)} className="adm-btn-ghost" disabled={saving === `hold-${profileCustomer.id}`}>
                  {saving === `hold-${profileCustomer.id}` ? '…' : <><PauseCircle size={14} /> Put on hold</>}
                </button>
              )}
              {profileSource !== 'proto-active' && !profileCustomer.is_approved && profileCustomer.application_status === 'on_hold' && (
                <button onClick={() => void returnApplicationToReview(profileCustomer)} className="adm-btn-ghost" disabled={saving === `review-${profileCustomer.id}`}>
                  {saving === `review-${profileCustomer.id}` ? '…' : 'Return to review'}
                </button>
              )}
              {profileSource !== 'proto-active' && profileCustomer.is_approved && (
                <button onClick={() => void deactivateCustomer(profileCustomer)} className="adm-btn-ghost" disabled={saving === `deact-${profileCustomer.id}`}>
                  {saving === `deact-${profileCustomer.id}` ? '…' : 'Deactivate account'}
                </button>
              )}
              <button
                onClick={() => void removeCustomer(profileCustomer, profileSource)}
                className="adm-btn-ghost"
                style={{ color: '#c40000' }}
                disabled={saving === (profileSource === 'proto-active' ? `del-proto-${profileCustomer.id}` : `del-${profileCustomer.id}`)}
              >
                {saving === (profileSource === 'proto-active' ? `del-proto-${profileCustomer.id}` : `del-${profileCustomer.id}`) ? '…' : <><Trash2 size={14} /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {customerEmailOpen && (
        <Suspense fallback={null}>
          <CustomerEmailModal
            open={customerEmailOpen}
            onClose={() => { setCustomerEmailOpen(false); setComposeTarget(null); }}
            customerTab={customerTab}
            onSend={sendCustomerEmailBroadcast}
            onShowToast={showToast}
            adminEmail={customer?.email || ''}
            initialAudience={composeTarget?.audience || null}
            initialBusinessTypes={composeTarget?.businessTypes || null}
            initialRecipients={composeTarget?.recipients || null}
            initialGroupId={composeTarget?.groupId || null}
          />
        </Suspense>
      )}

      {addCustomerOpen && (
        <AddCustomerModal
          open={addCustomerOpen}
          onClose={() => setAddCustomerOpen(false)}
          onShowToast={showToast}
          onAdded={() => { void loadCustomers(); }}
        />
      )}

      <TaxonomyModals
        taxonomyTree={taxonomyTree}
        editModal={editTaxonomyModal}
        deleteModal={deleteSubModal}
        newSubModal={newSubModal}
        newCategoryModal={newCategoryModal}
        saving={taxonomySaving}
        onCloseEdit={() => setEditTaxonomyModal(null)}
        onCloseDelete={() => setDeleteSubModal(null)}
        onCloseNewSub={() => setNewSubModal(null)}
        onCloseNewCategory={() => setNewCategoryModal(null)}
        onEditLabelChange={(label) => setEditTaxonomyModal((m) => ({ ...m, label }))}
        onNewSubParentChange={(parentId) => setNewSubModal((m) => ({ ...m, parentId }))}
        onNewSubLabelChange={(label) => setNewSubModal((m) => ({ ...m, label }))}
        onNewCategoryLabelChange={(label) => setNewCategoryModal((m) => ({ ...m, label }))}
        onSaveRename={saveTaxonomyRename}
        onConfirmDelete={confirmDeleteSubcategory}
        onSaveNewSub={saveNewSubcategory}
        onSaveNewCategory={saveNewCategory}
      />

      {/* Content quick-edit modal (image drag-drop + description) */}
      {contentEditProduct && (
        <div className="adm-modal-backdrop">
          <div className="adm-modal" style={{ maxWidth: 580 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 20, fontFamily: 'Outfit, sans-serif' }}>Edit image & description</h3>
                <p className="adm-muted" style={{ marginTop: 4, fontSize: 13 }}>{contentEditProduct.name}</p>
              </div>
              <button onClick={closeContentEdit} className="adm-icon-btn"><X size={16} /></button>
            </div>

            {/* Hidden file input */}
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImageFile(f); e.target.value = ''; }}
            />

            {/* Drop zone / preview */}
            <div
              onClick={() => !imageUploading && imageFileInputRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setImageDragOver(true); }}
              onDragOver={(e) => { e.preventDefault(); setImageDragOver(true); }}
              onDragLeave={(e) => { e.preventDefault(); setImageDragOver(false); }}
              onDrop={(e) => {
                e.preventDefault();
                setImageDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void uploadImageFile(file);
              }}
              style={{
                position: 'relative',
                marginBottom: 12,
                borderRadius: 10,
                border: `2px dashed ${imageDragOver ? '#8B1A1A' : contentEditForm.image ? '#d1d5db' : '#cbd5e1'}`,
                background: imageDragOver ? '#fff5f5' : contentEditForm.image ? '#f8f8f8' : '#f8fafc',
                height: 220,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: imageUploading ? 'wait' : 'pointer',
                overflow: 'hidden',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              {imageUploading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#8B1A1A' }}>
                  <Loader2 size={32} className="spin" />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Uploading…</span>
                </div>
              ) : contentEditForm.image ? (
                <>
                  <img
                    src={contentEditForm.image}
                    alt="Preview"
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                  <div style={{
                    position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)',
                    display: imageDragOver ? 'flex' : 'none',
                    alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#fff',
                  }}>
                    <Upload size={28} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Drop to replace</span>
                  </div>
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    padding: '6px 10px', background: 'rgba(0,0,0,0.5)',
                    color: '#fff', fontSize: 11, textAlign: 'center',
                    display: imageDragOver ? 'none' : 'block',
                  }}>
                    Click or drag a new image to replace
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: imageDragOver ? '#8B1A1A' : '#94a3b8', pointerEvents: 'none' }}>
                  <Upload size={32} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Drag & drop an image here</div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>or click to browse files</div>
                  </div>
                </div>
              )}
            </div>

            {/* Manual URL input */}
            <label style={{ display: 'grid', gap: 5, marginBottom: 18 }}>
              <span style={{ fontWeight: 700, fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Or paste image URL</span>
              <input
                value={contentEditForm.image}
                onChange={(e) => setContentEditForm((f) => ({ ...f, image: e.target.value }))}
                className="adm-field-input"
                placeholder="https://example.com/product.jpg"
                style={{ fontSize: 12 }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Website SKU (WSK)</span>
                <input
                  value={contentEditProduct?.websiteSku || ''}
                  readOnly
                  className="adm-field-input"
                  style={{ fontSize: 12, background: '#f8fafc', color: '#64748b', cursor: 'default' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 5 }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Barcode (BC)</span>
                <input
                  value={contentEditForm.code || ''}
                  onChange={(e) => setContentEditForm((f) => ({ ...f, code: e.target.value }))}
                  className="adm-field-input"
                  placeholder="Product barcode"
                  style={{ fontSize: 12 }}
                />
              </label>
            </div>

            {/* Description */}
            <label style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Description</span>
              <textarea
                value={contentEditForm.description}
                onChange={(e) => setContentEditForm((f) => ({ ...f, description: e.target.value }))}
                className="adm-field-input"
                rows={4}
                placeholder="Product description shown to customers…"
                style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </label>

            <label style={{ display: 'grid', gap: 6, marginBottom: 20 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Pack Description</span>
              <textarea
                value={contentEditForm.packDescription || ''}
                onChange={(e) => setContentEditForm((f) => ({ ...f, packDescription: e.target.value }))}
                className="adm-field-input"
                rows={2}
                placeholder="Pack / carton description…"
                style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </label>

            <div style={{ marginBottom: 20 }}>
              <SellingUnitField
                value={contentEditForm.unitsOfIssue}
                onChange={(unitsOfIssue) => setContentEditForm((form) => ({ ...form, unitsOfIssue }))}
                id="content-edit-selling-unit-options"
              />
            </div>

            {contentEditError && (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', borderRadius: 6, color: '#c40000', fontSize: 13 }}>
                {contentEditError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={closeContentEdit} className="adm-btn-ghost"><ChevronLeft size={15} /> Cancel</button>
              <button onClick={() => void saveContentEdit()} className="adm-btn-red" disabled={contentEditSaving || imageUploading}>
                {contentEditSaving ? 'Saving…' : <><Check size={15} /> Save to Supabase</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fulfillment modal */}
      {fulfillmentOrder && (
        <div className="adm-modal-backdrop">
          <div className="adm-modal" style={{ maxWidth: 740, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 20, fontFamily: 'Outfit, sans-serif', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ClipboardList size={20} style={{ color: '#15803d' }} /> Order Fulfillment
                </h3>
                <p className="adm-muted" style={{ marginTop: 4, fontSize: 13 }}>
                  {fulfillmentOrder.order_number || fulfillmentOrder.id.slice(0, 8)} &nbsp;·&nbsp; {new Date(fulfillmentOrder.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              <button onClick={closeFulfillment} className="adm-icon-btn"><X size={16} /></button>
            </div>

            {/* Customer details */}
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, flexShrink: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{fulfillmentOrder.customers?.name || 'Unknown customer'}</div>
              <div className="adm-muted" style={{ marginTop: 2 }}>{fulfillmentOrder.customers?.email || '—'}</div>
            </div>

            {/* Items table */}
            <div style={{ overflowY: 'auto', flex: 1, marginBottom: 14 }}>
              {/* Table header */}
              <div style={{ display: 'grid', gridTemplateColumns: '28px 24px 52px 90px 1fr 64px 72px 32px', gap: '0 8px', padding: '6px 8px', background: '#f1f5f9', borderRadius: 6, marginBottom: 4, fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', alignItems: 'center' }}>
                <span>✓</span><span>#</span><span>Img</span><span>Code</span><span>Product</span><span>Ordered</span><span>Final qty</span><span></span>
              </div>
              {fulfillmentItems.map((item, idx) => (
                <div key={idx}>
                  <div style={{ display: 'grid', gridTemplateColumns: '28px 24px 52px 90px 1fr 64px 72px 32px', gap: '0 8px', padding: '8px', borderBottom: '1px solid #f1f5f9', alignItems: 'center', background: item.checked ? '#f0fdf4' : 'white' }}>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => setFulfillmentItems((prev) => prev.map((it, i) => i === idx ? { ...it, checked: !it.checked } : it))}
                      style={{ width: 16, height: 16, accentColor: '#15803d', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700 }}>{idx + 1}</span>
                    <div style={{ width: 48, height: 48, borderRadius: 6, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {item.image
                        ? <img src={item.image} alt="" style={{ width: 48, height: 48, objectFit: 'contain', mixBlendMode: 'multiply' }} />
                        : <span style={{ fontSize: 9, color: '#9ca3af' }}>IMG</span>}
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 12, wordBreak: 'break-all' }}>{item.code || '—'}</span>
                    <span style={{ fontSize: 13 }}>{item.name || '—'}</span>
                    <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'center' }}>× {item.qty}</span>
                    <input
                      type="number"
                      min="0"
                      value={item.finalQty}
                      onChange={(e) => setFulfillmentItems((prev) => prev.map((it, i) => i === idx ? { ...it, finalQty: Math.max(0, Number(e.target.value)) } : it))}
                      className="adm-tiny-input"
                      style={{ width: 64, textAlign: 'center' }}
                    />
                    <button
                      onClick={() => { setEditingItemIdx(editingItemIdx === idx ? null : idx); setProductSwapSearch(''); setProductSwapResults([]); }}
                      className="adm-icon-btn"
                      title="Swap product"
                      style={{ color: editingItemIdx === idx ? '#8B1A1A' : undefined }}
                    >
                      <Pencil size={13} />
                    </button>
                  </div>

                  {/* Inline product swap */}
                  {editingItemIdx === idx && (
                    <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, margin: '4px 0 8px', display: 'grid', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 12, color: '#92400e' }}>Swap product — search by code or name</div>
                      <label className="adm-search" style={{ background: 'white' }}>
                        <Search size={13} />
                        <input
                          value={productSwapSearch}
                          onChange={(e) => handleSwapSearchChange(e.target.value)}
                          placeholder="Type code or product name…"
                          className="adm-search-input"
                          autoFocus
                        />
                        {productSwapLoading && <Loader2 size={13} className="spin" />}
                      </label>
                      {productSwapResults.length > 0 && (
                        <div style={{ display: 'grid', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                          {productSwapResults.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => swapFulfillmentItem(idx, p)}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                            >
                              {p.image
                                ? <img src={p.image} alt="" style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 4, flexShrink: 0 }} />
                                : <div style={{ width: 36, height: 36, background: '#f3f4f6', borderRadius: 4, flexShrink: 0 }} />}
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 12 }}>{p.code}</div>
                                <div style={{ color: '#374151' }}>{p.name}</div>
                              </div>
                              <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 12 }}>R{p.price}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {productSwapSearch && !productSwapLoading && productSwapResults.length === 0 && (
                        <div className="adm-muted" style={{ fontSize: 12 }}>No products found.</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Notes */}
            <div style={{ flexShrink: 0, marginBottom: 16 }}>
              <label style={{ display: 'grid', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>Notes</span>
                <textarea
                  value={fulfillmentNotes}
                  onChange={(e) => setFulfillmentNotes(e.target.value)}
                  className="adm-field-input"
                  rows={4}
                  placeholder={'Add clear notes, one point per line…\nExample:\nCustomer approved substitution\nDeliver with next stock run'}
                  style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
                />
              </label>
              <div style={{ marginTop: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Notes preview</div>
                {renderNoteSections(fulfillmentNoteSections)}
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
              <button onClick={closeFulfillment} className="adm-btn-ghost"><ChevronLeft size={15} /> Cancel</button>
              <button onClick={() => void saveFulfillment()} className="adm-btn-red" disabled={fulfillmentSaving}>
                {fulfillmentSaving ? 'Saving…' : <><Check size={15} /> Save order</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {imageViewUrl && (
        <div
          onClick={() => setImageViewUrl('')}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={imageViewUrl}
            alt="Product"
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setImageViewUrl('')}
            style={{ position: 'absolute', top: 20, right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* Product editor modal */}
      {editorOpen && (
        <div className="adm-modal-backdrop" onClick={closeEditor}>
          <div className="adm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 22, fontFamily: 'Outfit, sans-serif' }}>{editingProduct ? 'Edit product' : 'Add product'}</h3>
                <p className="adm-muted" style={{ marginTop: 4 }}>Fill in the details and assign a category.</p>
              </div>
              <button onClick={closeEditor} className="adm-icon-btn"><X size={16} /></button>
            </div>

            <div style={{ overflowY: 'auto', paddingRight: 4, flex: 1, minHeight: 0 }}>

            {PRODUCT_IMAGE_SLOTS.map((slot) => (
              <input
                key={`file-${slot.key}`}
                ref={(el) => { editorImageFileInputRefs.current[slot.key] = el; }}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadEditorImageFile(file, slot.key);
                  e.target.value = '';
                }}
              />
            ))}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
              <AdminField label="Product code"><input type="text" value={productForm.code} onChange={(e) => setProductForm((p) => ({ ...p, code: e.target.value }))} className="adm-field-input" /></AdminField>
              <AdminField label="Product name" full><input type="text" value={productForm.name} onChange={(e) => setProductForm((p) => ({ ...p, name: e.target.value }))} className="adm-field-input" /></AdminField>
              <AdminField label="Description" full>
                <textarea value={productForm.description} onChange={(e) => setProductForm((p) => ({ ...p, description: e.target.value }))} className="adm-field-input" rows={3} style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} placeholder="Product description shown to customers…" />
              </AdminField>
              <AdminField label="Pack Description" full>
                <textarea value={productForm.packDescription} onChange={(e) => setProductForm((p) => ({ ...p, packDescription: e.target.value }))} className="adm-field-input" rows={2} style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} placeholder="Pack / carton description…" />
              </AdminField>
              <SellingUnitField
                value={productForm.unitsOfIssue}
                onChange={(unitsOfIssue) => setProductForm((product) => ({ ...product, unitsOfIssue }))}
                id="product-editor-selling-unit-options"
              />
              <AdminField label="Minimum order quantity">
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="9999"
                  step="1"
                  value={productForm.minQty}
                  onChange={(e) => setProductForm((product) => ({ ...product, minQty: e.target.value }))}
                  className="adm-field-input"
                />
                <p className="adm-muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                  Number of selling units required. Example: Pack 10 with minimum 3 means the customer orders at least 3 packs.
                </p>
              </AdminField>

              <AdminField label="Product images (up to 4)" full>
                <p className="adm-muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
                  Best size: 800×800 px square, white background, product centred — matches your resize script and catalog cards.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  {PRODUCT_IMAGE_SLOTS.map((slot, slotIndex) => {
                    const value = productForm[slot.key];
                    const isDragOver = editorImageDragOver === slot.key;
                    const nextKey = PRODUCT_IMAGE_SLOTS[slotIndex + 1]?.key;
                    return (
                      <div key={slot.key} style={{ display: 'grid', gap: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>{slot.label}</span>
                          {nextKey && (
                            <button
                              type="button"
                              onClick={() => swapEditorImageSlots(slotIndex)}
                              className="adm-btn-ghost"
                              style={{ padding: '6px 10px', fontSize: 12 }}
                              disabled={!productForm[slot.key] && !productForm[nextKey]}
                            >
                              Swap {slotIndex + 1} ↔ {slotIndex + 2}
                            </button>
                          )}
                        </div>
                        <div
                          onClick={() => !editorImageUploading && editorImageFileInputRefs.current[slot.key]?.click()}
                          onDragEnter={(e) => { e.preventDefault(); setEditorImageDragOver(slot.key); }}
                          onDragOver={(e) => { e.preventDefault(); setEditorImageDragOver(slot.key); }}
                          onDragLeave={(e) => { e.preventDefault(); if (editorImageDragOver === slot.key) setEditorImageDragOver(''); }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setEditorImageDragOver('');
                            const file = e.dataTransfer.files?.[0];
                            if (file) void uploadEditorImageFile(file, slot.key);
                          }}
                          style={{
                            position: 'relative',
                            minHeight: 160,
                            borderRadius: 16,
                            border: `2px dashed ${isDragOver ? '#8B1A1A' : value ? '#d1d5db' : '#cbd5e1'}`,
                            background: isDragOver ? '#fff5f5' : '#f8fafc',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: editorImageUploading ? 'wait' : 'pointer',
                            overflow: 'hidden',
                            transition: 'border-color 0.15s, background 0.15s',
                          }}
                        >
                          {editorImageUploading && isDragOver ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#8B1A1A' }}>
                              <Loader2 size={32} className="spin" />
                              <span style={{ fontSize: 13, fontWeight: 600 }}>Uploading image…</span>
                            </div>
                          ) : value ? (
                            <>
                              <img src={value} alt={`${slot.label} preview`} style={{ maxWidth: '100%', maxHeight: 160, objectFit: 'contain' }} />
                              <div style={{ position: 'absolute', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: isDragOver ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#fff' }}>
                                <Upload size={28} />
                                <span style={{ fontSize: 13, fontWeight: 600 }}>Drop to replace image</span>
                              </div>
                              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '8px 12px', background: 'rgba(15, 23, 42, 0.55)', color: '#fff', fontSize: 12, textAlign: 'center' }}>
                                Click or drag a new image here to replace it
                              </div>
                            </>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: isDragOver ? '#8B1A1A' : '#64748b', pointerEvents: 'none', textAlign: 'center', padding: 20 }}>
                              <Upload size={32} />
                              <div style={{ fontWeight: 700, fontSize: 15 }}>Drag & drop image here</div>
                              <div style={{ fontSize: 12 }}>or click to browse and upload it to Supabase</div>
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="button" onClick={() => editorImageFileInputRefs.current[slot.key]?.click()} className="adm-btn-ghost" style={{ padding: '8px 12px', fontSize: 12 }} disabled={editorImageUploading}>
                            Upload
                          </button>
                          {value && (
                            <button type="button" onClick={() => clearEditorImage(slot.key)} className="adm-btn-ghost" style={{ padding: '8px 12px', fontSize: 12 }} disabled={editorImageUploading}>
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </AdminField>

              {PRODUCT_IMAGE_SLOTS.map((slot) => (
                <AdminField key={`url-${slot.key}`} label={`${slot.label} URL`} full>
                  <input
                    type="text"
                    value={productForm[slot.key]}
                    onChange={(e) => setProductForm((p) => ({ ...p, [slot.key]: e.target.value }))}
                    className="adm-field-input"
                  />
                </AdminField>
              ))}
              <AdminField label="Price"><input type="text" inputMode="decimal" value={productForm.price} onChange={(e) => setProductForm((p) => ({ ...p, price: e.target.value }))} className="adm-field-input" /></AdminField>
              {/* SOH comes from the ERP sync — an editable field here silently discarded input. */}
              <AdminField label="Stock on hand (synced from ERP)"><input type="text" value={productForm.stockOnHand} readOnly disabled className="adm-field-input" title="Stock on hand is synced from the ERP and cannot be edited here" /></AdminField>
              {/* Live-catalogue flags (moved here from the row buttons). Applied on
                  Save; only shown for live products. */}
              {editingProduct && !editingProduct.archivedBy && (
                <AdminField label="Homepage & ordering" full>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={!!productForm.isNewArrival} onChange={(e) => setProductForm((p) => ({ ...p, isNewArrival: e.target.checked }))} />
                      <span>Show in the <strong>New Stock</strong> ribbon on the homepage</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={!!productForm.toOrder} onChange={(e) => setProductForm((p) => ({ ...p, toOrder: e.target.checked }))} />
                      <span><strong>Made / sourced to order</strong> — customers can order this at zero stock and will see an extra-lead-time disclaimer</span>
                    </label>

                    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12, display: 'grid', gap: 10 }}>
                      <div>
                        <strong style={{ fontSize: 13 }}>Incoming container stock</strong>
                        <p className="adm-muted" style={{ margin: '3px 0 0', fontSize: 12 }}>
                          Separate from made-to-order. ERP stock remains the exact stock-on-hand source.
                        </p>
                      </div>
                      {productForm.availabilityLoading ? (
                        <span className="adm-muted" style={{ fontSize: 12 }}>Loading availability…</span>
                      ) : productForm.availabilitySchemaReady === false ? (
                        <span style={{ fontSize: 12, color: '#b45309', fontWeight: 700 }}>Migration 059 is required before incoming stock can be saved.</span>
                      ) : (
                        <>
                          <select
                            className="adm-field-input"
                            value={productForm.incomingStatus}
                            onChange={(e) => setProductForm((p) => ({
                              ...p,
                              incomingStatus: e.target.value,
                              ...(e.target.value === 'none' ? {
                                incomingQty: '', incomingEta: '', shipmentRef: '', allowPreorder: false,
                              } : {}),
                            }))}
                            aria-label="Incoming stock status"
                          >
                            <option value="none">No incoming stock</option>
                            <option value="on_the_way">On the way</option>
                            <option value="customs">In customs</option>
                            <option value="landed_awaiting_grv">Landed — awaiting GRV</option>
                            <option value="partially_received">Partially received</option>
                          </select>
                          {productForm.incomingStatus !== 'none' && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                              <label style={{ display: 'grid', gap: 5, fontSize: 12, fontWeight: 700 }}>
                                Expected quantity
                                <input className="adm-field-input" type="number" min="0.001" step="0.001" value={productForm.incomingQty} onChange={(e) => setProductForm((p) => ({ ...p, incomingQty: e.target.value }))} />
                              </label>
                              <label style={{ display: 'grid', gap: 5, fontSize: 12, fontWeight: 700 }}>
                                ETA
                                <input className="adm-field-input" type="date" value={productForm.incomingEta} onChange={(e) => setProductForm((p) => ({ ...p, incomingEta: e.target.value }))} />
                              </label>
                              <label style={{ display: 'grid', gap: 5, fontSize: 12, fontWeight: 700, gridColumn: '1 / -1' }}>
                                Container / shipment reference
                                <input className="adm-field-input" type="text" maxLength="120" value={productForm.shipmentRef} onChange={(e) => setProductForm((p) => ({ ...p, shipmentRef: e.target.value }))} placeholder="Optional internal reference" />
                              </label>
                            </div>
                          )}
                          {['on_the_way', 'customs'].includes(productForm.incomingStatus) && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                              <input type="checkbox" checked={!!productForm.allowPreorder} onChange={(e) => setProductForm((p) => ({ ...p, allowPreorder: e.target.checked }))} />
                              <span>Allow customers to pre-order before the shipment lands</span>
                            </label>
                          )}
                          {['landed_awaiting_grv', 'partially_received'].includes(productForm.incomingStatus) && (
                            <span style={{ fontSize: 12, color: '#245aa7', fontWeight: 700 }}>
                              Customers can order this while receiving is completed; the quote confirms final quantity.
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </AdminField>
              )}
              {/*
                Cascading category pickers — Main, then Child 1..N as deep as the
                taxonomy tree goes (no fixed depth cap). Each level renders only
                while its parent has a value and there are options to choose (or
                a stale value to preserve) — the loop stops the moment a level
                would render nothing, which also naturally offers exactly one
                more empty picker at the deepest populated level.
                Hidden for archived products — category is chosen at Make live instead.
              */}
              {!editingProduct?.archivedBy && (
              <>
              <AdminField label="Main category" full>
                <select
                  value={productForm.categoryId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const firstChild = subcategoryOptions(nextId, taxonomyTree)[0]?.id || '';
                    setProductForm((p) => ({
                      ...p,
                      categoryId: nextId,
                      childIds: firstChild ? [firstChild] : [],
                    }));
                  }}
                  className="adm-field-input"
                >
                  {mainCategories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </AdminField>

              {(() => {
                const childIds = productForm.childIds || [];
                const fields = [];
                let parentId = productForm.categoryId;
                for (let level = 1; parentId; level += 1) {
                  const rawOptions = level === 1
                    ? subcategoryOptions(productForm.categoryId, taxonomyTree)
                    : childrenOf(taxonomyTree, parentId);
                  const currentValue = childIds[level - 1] || '';
                  const options = withCurrentOption(rawOptions, currentValue);
                  if (!options.length) break;
                  fields.push({ level, options, currentValue });
                  parentId = currentValue;
                }
                return fields.map(({ level, options, currentValue }) => (
                  <AdminField key={level} label={`Child category ${level}`}>
                    <select
                      value={currentValue}
                      onChange={(e) => setProductForm((p) => ({
                        ...p,
                        childIds: [...(p.childIds || []).slice(0, level - 1), e.target.value].filter(Boolean),
                      }))}
                      className="adm-field-input"
                    >
                      <option value="">— None —</option>
                      {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </AdminField>
                ));
              })()}
              </>
              )}
            </div>
            {/* Extra categories are stored separately from the product row, so
                they are only editable once the product exists.

                MUST stay inside the scrollable body above. Outside it, the
                panel sits in the modal's fixed region and pushes its own Add
                button past maxHeight: 92vh, where it cannot be clicked. */}
            {editingProduct?.sku && (
              <div style={{ marginTop: 14 }}>
                <PlacementsEditor websiteSku={editingProduct.sku} taxonomyTree={taxonomyTree} />
              </div>
            )}
            </div>
            {editorError && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', borderRadius: 6, color: '#c40000', fontSize: 13, flexShrink: 0 }}>
                {editorError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
              <button type="button" onClick={closeEditor} className="adm-btn-ghost"><ChevronLeft size={15} /> Cancel</button>
              <button type="button" onClick={() => void saveProduct()} className="adm-btn-red" disabled={editorImageUploading}>
                {saving === 'new-product' || saving === editingProduct?.id ? 'Saving…' : <><Check size={15} /> Save product</>}
              </button>
            </div>
          </div>
        </div>
      )}


      {fulfillmentSettingsOpen && (
        <Suspense fallback={null}>
          <FulfillmentSettingsModal
            open={fulfillmentSettingsOpen}
            taxonomyTree={taxonomyTree}
            onClose={(saved) => {
              setFulfillmentSettingsOpen(false);
              if (saved) void fetchFulfillmentUsers().then(setFulfillmentUsers);
            }}
          />
        </Suspense>
      )}

      {toast && (
        <div className={`adm-toast adm-toast--${toast.type}`} role="status">{toast.message}</div>
      )}
    </div>
  );
}

function OrderItemsList({ label, items }) {
  return (
    <div className="adm-subtle-box">
      <strong style={{ fontSize: 12 }}>{label}</strong>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.length === 0 && <span className="adm-muted" style={{ fontSize: 12 }}>—</span>}
        {items.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 40, height: 40, borderRadius: 5, background: '#f3f4f6', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {item.image
                ? <img src={item.image} alt="" style={{ width: 40, height: 40, objectFit: 'contain', mixBlendMode: 'multiply' }} />
                : <span style={{ fontSize: 8, color: '#9ca3af' }}>IMG</span>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#374151' }}>{item.code}</div>
              <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.name}</div>
            </div>
            <span style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>× {item.qty}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminField({ label, children, full = false }) {
  return (
    <label style={{ display: 'grid', gap: 6, gridColumn: full ? '1 / -1' : undefined }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{label}</span>
      {children}
    </label>
  );
}

function DrawerField({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="adm-drawer-field">
      <Icon size={14} className="adm-drawer-field-icon" />
      <div>
        <div className="adm-drawer-field-label">{label}</div>
        <div className="adm-drawer-field-value">{value}</div>
      </div>
    </div>
  );
}

function AdminStat({ label, value, accent }) {
  const display = typeof value === 'object' ? '—' : value;
  return (
    <div className={`adm-stat${accent ? ' adm-stat--accent' : ''}`}>
      <div className="adm-stat-value">{display}</div>
      <div className="adm-stat-label">{label}</div>
    </div>
  );
}

function Pager({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20 }}>
      <button onClick={() => onChange(Math.max(1, page - 1))} className="adm-btn-ghost" disabled={page <= 1}><ChevronLeft size={15} /> Prev</button>
      <span className="adm-muted">Page {page} of {totalPages}</span>
      <button onClick={() => onChange(Math.min(totalPages, page + 1))} className="adm-btn-ghost" disabled={page >= totalPages}>Next <ChevronRight size={15} /></button>
    </div>
  );
}
