export async function fetchCustomersPage({ page = 1, pageSize = 50, tab = 'regular', searchQuery = '', businessType = '' } = {}) {
  const params = new URLSearchParams({ tab, page: String(page), pageSize: String(pageSize), search: searchQuery });
  if (businessType) params.set('business_type', businessType);
  const res = await fetch(`/api/admin-customers?${params}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to fetch customers');
  // orderCount is included server-side — no second round-trip needed
  return {
    rows: json.rows || [],
    total: json.total || 0,
    batches: json.batches || [],
    page: json.page || page,
    pageSize: json.pageSize || pageSize,
  };
}

export async function deleteCustomer(id) {
  const res = await fetch('/api/admin-customers', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error || 'Failed to delete customer');
    err.code = json.code;
    err.orderCount = json.orderCount;
    throw err;
  }
}

export async function approveCustomer(id, approved = true, { customerCode } = {}) {
  const code = customerCode ? String(customerCode).trim().toUpperCase() : '';
  if (approved && code && !/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error('Customer code must be exactly 6 letters or numbers');
  }
  const body = { id, is_approved: approved };
  if (customerCode) body.customer_code = code;
  const res = await fetch('/api/admin-customers', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to approve customer');
  return json;
}

export async function fetchProtoActiveCustomersPage({ page = 1, pageSize = 50, searchQuery = '', batch = '' } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (searchQuery) params.set('search', searchQuery);
  if (batch) params.set('batch', batch);
  const res = await fetch(`/api/proto-active-customers?${params}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to fetch proto active customers');
  return {
    rows: json.rows || [],
    total: json.total || 0,
    page: json.page || page,
    pageSize: json.pageSize || pageSize,
    migrationRequired: json.migrationRequired,
    message: json.message,
  };
}

export async function updateProtoActiveCustomer(id, fields) {
  const res = await fetch('/api/proto-active-customers', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...fields }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update proto active customer');
  return json.row;
}

export async function deleteProtoActiveCustomer(id) {
  const res = await fetch('/api/proto-active-customers', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete proto active customer');
}

export async function deleteAllProtoActiveCustomers() {
  const res = await fetch('/api/proto-active-customers', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true, confirm: 'DELETE ALL CUSTOMERS' }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete all customers');
  return json;
}

/** Import CSV rows (Account, CompanyName, ContactName, EmailAddress, TotalSpend) into pre-registration. */
export async function importProtoActiveCustomers(rows, batchLabel = '', tags = []) {
  const res = await fetch('/api/proto-active-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'import', rows, batchLabel, tags }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Customer import failed');
  return json;
}

/**
 * Manually add a customer into a chosen section.
 * section: 'approved' | 'approved-10000' | 'pre-registration' | '10000-club'
 * Never generates a customer code.
 */
export async function addCustomerManually({ section, ...fields }) {
  const res = await fetch('/api/admin-customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, ...fields }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to add customer');
  return json;
}

/** Send a TEST copy of an email template to yourself. */
export async function sendEmailTemplateTest({ template, to, subject, introText, htmlBlock }) {
  const res = await fetch('/api/email-test-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template, to, subject, introText, htmlBlock }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Test send failed');
  return json;
}

export async function syncBrevoContacts() {
  const res = await fetch('/api/brevo-sync', { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Brevo sync failed');
  return json;
}

export async function pushPortalCustomersToBrevo() {
  const res = await fetch('/api/customer-brevo-sync-portal', { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Push to Brevo failed');
  return json;
}

export async function sendCustomerEmailBroadcast({
  audience, subject, introText, htmlBlock, testEmail, businessTypes, recipients, importBatch, groupId,
}) {
  const res = await fetch('/api/customer-email-broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // groupId MUST be forwarded: the API rejects audience 'group' without it,
      // so dropping it here fails every group send with "Choose a group to send to."
      audience, subject, introText, htmlBlock, testEmail, businessTypes, recipients, importBatch, groupId,
    }),
  });
  const json = await res.json();
  if (!res.ok && res.status !== 207) throw new Error(json.error || 'Email send failed');
  return json;
}

export async function fetchCrmContactsPage({ page = 1, pageSize = 1 } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await fetch(`/api/crm-contacts?${params}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'CRM load failed');
  return json;
}

export async function seedProtoActiveCustomers() {
  const res = await fetch('/api/seed-proto-active-customers', { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Import failed');
  return json;
}

/**
 * PATCH a customer. Returns the full response { row, welcomeEmail }
 * so callers can tell whether a confirmation email was sent (it only sends when
 * a code is newly assigned to an approved customer).
 */
export async function updateCustomerAdmin(id, fields) {
  const res = await fetch('/api/admin-customers', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...fields }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update customer');
  return json;
}

/**
 * Pre-registration upload groups for the email composer.
 *
 * Uses its own admin-guarded endpoint rather than proto-active-customers,
 * which is owner-only — a non-owner admin got a 403 there and no groups.
 */
export async function fetchCustomerImportBatches() {
  const res = await fetch('/api/customer-import-batches');
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load upload groups');
  return json.batches || [];
}
