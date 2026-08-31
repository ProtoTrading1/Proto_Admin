/** Format checkout delivery choice for PDF/email. */
export function formatDeliveryMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (!m) return '';
  if (/pick.?up|collect|in.?store/i.test(m)) return 'In store pick up';
  if (m.includes('proto') && (m.includes('deliver') || m.includes('trading'))) return 'Proto to deliver';
  if (m.includes('own') || (m.includes('customer') && m.includes('courier'))) {
    return 'Customer elected their own courier';
  }
  if (m === 'proto' || m === 'proto-deliver') return 'Proto to deliver';
  if (m === 'own' || m === 'own-courier') return 'Customer elected their own courier';
  return String(method || '').trim();
}

/** Resolve delivery method from an order row or send payload. */
export function resolveDeliveryMethod(order = {}) {
  const raw = order.delivery_method
    || order.deliveryMethod
    || order.courier_choice
    || order.courierChoice
    || '';
  return formatDeliveryMethod(raw) || String(raw || '').trim();
}

/**
 * Shipping-method label for the online order confirmation. The new online store
 * offers exactly two choices, so every order maps to one of them:
 *   • "Proto to Quote Delivery" — Proto arranges delivery and quotes the cost
 *   • "In store pick up"        — customer collects / arranges their own courier
 */
export function pdfShippingMethod(order = {}) {
  const raw = String(
    order.delivery_method || order.deliveryMethod || order.courier_choice || order.courierChoice || '',
  ).trim().toLowerCase();
  if (!raw) return 'Proto to Quote Delivery';
  if (/pick.?up|collect|in.?store|\bstore\b|\bown\b|courier/.test(raw)) return 'In store pick up';
  return 'Proto to Quote Delivery';
}

function splitAddressLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Full "Invoice To" address block (contact, business, physical address, contact details). */
export function invoiceToLines(order = {}) {
  const c = order.customers || {};
  const contact = c.contact_name || c.name || '';
  const lines = [];
  if (contact) lines.push(contact);
  if (c.business_name && c.business_name !== contact) lines.push(c.business_name);
  splitAddressLines(c.company_address).forEach((l) => lines.push(l));
  const region = [c.city, c.province].filter(Boolean).join(', ');
  if (region) lines.push(region);
  const postal = c.postal_code || c.postcode || c.zip || '';
  if (postal) lines.push(String(postal));
  if (c.country) lines.push(c.country);
  if (c.phone) lines.push(`Phone: ${c.phone}`);
  if (c.email) lines.push(`Email: ${c.email}`);
  return lines;
}

/** Full "Delivery Address" block — falls back to the physical address when no
 *  separate delivery address is on file. */
export function deliveryAddressLines(order = {}) {
  const c = order.customers || {};
  const contact = c.contact_name || c.name || '';
  const lines = [];
  if (contact) lines.push(contact);
  if (c.business_name && c.business_name !== contact) lines.push(c.business_name);
  const addr = c.delivery_address || c.company_address || '';
  splitAddressLines(addr).forEach((l) => lines.push(l));
  const region = [c.city, c.province].filter(Boolean).join(', ');
  if (region) lines.push(region);
  if (c.country) lines.push(c.country);
  return lines.length ? lines : ['Same as invoice address'];
}

export function stripNoteBullet(line) {
  return String(line || '').replace(/^[\s•·\-–—]+/, '').trim();
}

/** Build auto change lines from confirmed vs original order rows. */
export function deriveAutoNotesFromItems(items = []) {
  const lines = [];
  for (const item of items) {
    if (item.removed) {
      lines.push(`${item.code} — ${item.name}: Out of stock`);
    } else if (item.swapped) {
      lines.push(`${item.originalCode || item.code} — ${item.originalName || item.name}: Substituted with ${item.code}`);
    } else {
      const ordered = item.originalQty != null ? item.originalQty : item.qty;
      const confirmed = item.qty ?? item.finalQty ?? 0;
      if (ordered !== confirmed) {
        lines.push(`${item.code} — ${item.name}: Qty ${ordered} -> ${confirmed}`);
      }
    }
  }
  return lines;
}

export function buildOrderNoteSections({ assignedTo = '', autoNotes = '', userNotes = '', customerNotes = '' } = {}) {
  const autoLines = (Array.isArray(autoNotes) ? autoNotes : String(autoNotes || '').split('\n'))
    .map(stripNoteBullet)
    .filter(Boolean);
  const userLines = String(userNotes || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const checkoutLines = String(customerNotes || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return [
    checkoutLines.length ? { title: 'Customer notes', lines: checkoutLines } : null,
    assignedTo ? { title: 'Handled by', lines: [assignedTo] } : null,
    autoLines.length ? { title: 'Order changes', lines: autoLines } : null,
    userLines.length ? { title: 'Additional notes', lines: userLines } : null,
  ].filter(Boolean);
}

export function customerDetailRows(order = {}) {
  const c = order.customers || {};
  const contactName = c.contact_name || c.name || '';
  const businessName = c.business_name || '';
  const location = [c.city, c.province, c.country].filter(Boolean).join(', ');
  const rows = [];

  if (contactName) rows.push({ label: 'Customer', value: contactName });
  if (businessName && businessName !== contactName) rows.push({ label: 'Company', value: businessName });
  if (c.email) rows.push({ label: 'Email', value: c.email });
  if (c.phone) rows.push({ label: 'Phone', value: c.phone });
  if (c.business_type) rows.push({ label: 'Business type', value: c.business_type });
  if (location) rows.push({ label: 'Location', value: location });
  if (c.delivery_address) rows.push({ label: 'Delivery address', value: c.delivery_address });

  const delivery = resolveDeliveryMethod(order);
  if (delivery) rows.push({ label: 'Delivery', value: delivery });
  return rows;
}

/** Keep customer and company identities distinct anywhere an order email names the buyer. */
export function customerEmailIdentity(customer = {}) {
  const customerName = String(customer.contact_name || customer.name || '').trim();
  const rawCompanyName = String(customer.business_name || '').trim();
  return {
    customerName,
    companyName: rawCompanyName && rawCompanyName !== customerName ? rawCompanyName : '',
  };
}
