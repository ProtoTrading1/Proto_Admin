import { fetchCustomersPage, fetchProtoActiveCustomersPage } from './customers';

const PORTAL_PAGE_SIZE = 200; // admin-customers caps pageSize at 200
const PROTO_PAGE_SIZE = 100; // proto-active-customers caps pageSize at 100

async function drainPages(fetchPage, pageSize) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await fetchPage(page);
    const rows = data.rows || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 500) break; // runaway guard
  }
  return all;
}

/** Every portal customer = union of the requests + regular tabs. */
async function fetchAllPortalCustomers() {
  const all = [];
  for (const tab of ['requests', 'regular']) {
    const rows = await drainPages(
      (page) => fetchCustomersPage({ tab, page, pageSize: PORTAL_PAGE_SIZE, searchQuery: '' }),
      PORTAL_PAGE_SIZE,
    );
    all.push(...rows);
  }
  return all;
}

const yesNo = (v) => (v ? 'Yes' : 'No');
const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');

const PORTAL_COLUMNS = [
  { header: 'Customer code', value: (r) => r.customer_code || r.account_code || '' },
  { header: 'Name', key: 'name' },
  { header: 'First name', key: 'first_name' },
  { header: 'Contact name', key: 'contact_name' },
  { header: 'Business name', key: 'business_name' },
  { header: 'Email', key: 'email' },
  { header: 'Phone', key: 'phone' },
  { header: 'Business type', key: 'business_type' },
  { header: 'Approved', value: (r) => yesNo(r.is_approved) },
  { header: 'Tier', key: 'tier' },
  { header: 'Orders', value: (r) => r.orderCount ?? 0 },
  { header: 'Monthly spend', key: 'monthly_spend' },
  { header: 'Sales last 12m', key: 'sales_last_12_months' },
  { header: 'Invoice count', key: 'invoice_count' },
  { header: 'Last purchase', value: (r) => dateOnly(r.last_purchase_date) },
  { header: 'City', key: 'city' },
  { header: 'Province', key: 'province' },
  { header: 'Country', key: 'country' },
  { header: 'WhatsApp opt-in', value: (r) => yesNo(r.accept_whatsapp) },
  { header: 'Registered', value: (r) => dateOnly(r.created_at) },
];

const PROTO_COLUMNS = [
  { header: 'Account code', value: (r) => r.account_code || r.customer_code || '' },
  { header: 'Name', key: 'name' },
  { header: 'Contact name', key: 'contact_name' },
  { header: 'First name', key: 'first_name' },
  { header: 'Email', key: 'email' },
  { header: 'Sales last 12m', key: 'sales_last_12_months' },
  { header: 'Invoice count', key: 'invoice_count' },
  { header: 'Last purchase', value: (r) => dateOnly(r.last_purchase_date) },
];

function sheetData(columns, rows) {
  return [
    columns.map((c) => c.header),
    ...rows.map((row) => columns.map((c) => (typeof c.value === 'function' ? c.value(row) : row[c.key] ?? ''))),
  ];
}

/**
 * Export every customer to one workbook: portal accounts (trade requests +
 * approved) on one sheet, pre-registration contacts on another.
 * Returns { portal, preRegistration } row counts for the toast.
 */
export async function exportAllCustomersXlsx() {
  const [portalRows, protoResult] = await Promise.all([
    fetchAllPortalCustomers(),
    drainPages(
      (page) => fetchProtoActiveCustomersPage({ page, pageSize: PROTO_PAGE_SIZE, searchQuery: '' }),
      PROTO_PAGE_SIZE,
    ).catch(() => []), // pre-registration table may be unmigrated — export portal customers regardless
  ]);

  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData(PORTAL_COLUMNS, portalRows)), 'Portal customers');
  if (protoResult.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData(PROTO_COLUMNS, protoResult)), 'Pre-registration');
  }
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `proto-customers-${stamp}.xlsx`);
  return { portal: portalRows.length, preRegistration: protoResult.length };
}
