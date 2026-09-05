export const ORDER_WORKSPACE_STATUSES = [
  'Draft',
  'Pending Review',
  'Quoted',
  'Waiting Supplier',
  'Ordered',
  'Waiting Arrival',
  'Ready',
  'Delivered',
  'Closed',
];

export const ORDER_WORKSPACE_STATUS_SET = new Set(ORDER_WORKSPACE_STATUSES);

const TRANSITIONS = {
  Draft: ['Pending Review', 'Closed'],
  'Pending Review': ['Draft', 'Quoted', 'Waiting Supplier', 'Closed'],
  Quoted: ['Waiting Supplier', 'Ordered', 'Closed'],
  'Waiting Supplier': ['Ordered', 'Closed'],
  Ordered: ['Waiting Arrival', 'Ready', 'Closed'],
  'Waiting Arrival': ['Ready', 'Closed'],
  Ready: ['Delivered', 'Closed'],
  Delivered: ['Closed'],
  Closed: [],
};

export function assertValidStatus(status) {
  if (!ORDER_WORKSPACE_STATUS_SET.has(status)) {
    throw new Error(`Invalid order workspace status: ${status}`);
  }
  return status;
}

export function assertValidTransition(from, to) {
  assertValidStatus(from);
  assertValidStatus(to);
  if (from === to) return to;
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid order workspace transition: ${from} -> ${to}`);
  }
  return to;
}

export function parseOrderCommand(query) {
  const raw = String(query || '').trim();
  const match = raw.match(/^\/order(?:\s+(.+))?$/i);
  if (!match) return null;
  const customerQuery = String(match[1] || '').trim();
  return {
    command: raw,
    customerQuery,
  };
}

export function customerSnapshot(row, fallback = '') {
  if (!row) {
    const label = String(fallback || '').trim();
    return {
      customerId: null,
      customerName: label,
      account: '',
      contact: label,
      email: '',
      phone: '',
      notes: '',
    };
  }
  const customerName = row.business_name || row.name || '';
  return {
    customerId: row.id || null,
    customerName,
    account: row.customer_code || '',
    contact: row.contact_name || row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    notes: '',
  };
}

export function resolveCustomerMatch(matches = [], customerQuery = '') {
  const q = String(customerQuery || '').trim().toLowerCase();
  if (!q || !matches.length) return { customer: null, ambiguous: false };
  const exact = matches.filter((c) => [c.business_name, c.name, c.contact_name, c.email, c.customer_code]
    .filter(Boolean)
    .some((v) => String(v).trim().toLowerCase() === q));
  if (exact.length === 1) return { customer: exact[0], ambiguous: false };
  if (matches.length === 1 && q.length >= 4) return { customer: matches[0], ambiguous: false };
  if (matches.length > 1) return { customer: null, ambiguous: true, matches };
  return { customer: null, ambiguous: false };
}

export function normalizeLine(input = {}) {
  return {
    sku: String(input.sku || input.code || '').trim(),
    description: String(input.description || input.name || '').trim(),
    requestedQty: Number(input.requestedQty ?? input.qty ?? input.quantity ?? 0) || 0,
    confirmedQty: Number(input.confirmedQty ?? input.requestedQty ?? input.qty ?? input.quantity ?? 0) || 0,
    status: String(input.status || 'Draft'),
    supplier: String(input.supplier || '').trim(),
    price: input.price === '' || input.price == null ? null : Number(input.price) || null,
    availability: String(input.availability || '').trim(),
  };
}

export function isOverdueDate(value, now = new Date()) {
  if (!value) return false;
  const due = new Date(`${value}T23:59:59`);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

export function workspaceDeadlines({ tasks = [], promises = [], reminders = [] } = {}, now = new Date()) {
  return {
    overdueTasks: tasks.filter((t) => t.status === 'Open' && isOverdueDate(t.due_date || t.dueDate, now)),
    overduePromises: promises.filter((p) => p.status === 'Open' && isOverdueDate(p.due_date || p.dueDate, now)),
    overdueReminders: reminders.filter((r) => r.status === 'Open' && isOverdueDate(r.due_date || r.dueDate, now)),
  };
}

