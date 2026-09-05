import { requireAdminOrOrderToken, requireAdminAuthType } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { getPortalAdminClient, SITE_CONFIG_BUCKET } from './_site-config.js';
import { CUSTOMER_SEND_FORBIDDEN, isVictorSender } from './_fulfillment-auth.js';
import { markOrderConfirmationSent } from './_order-confirmation-sent.js';
import { markCustomerEmailed } from './_customer-email-status.js';
import {
  buildOrderNoteSections,
  customerDetailRows,
  deriveAutoNotesFromItems,
  formatDeliveryMethod,
  resolveDeliveryMethod,
} from './_order-format.js';

async function markConfirmationSent(orderId) {
  return markOrderConfirmationSent(orderId);
}

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function escapeHtml(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeImageUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return '';
    return escapeHtml(parsed.href);
  } catch {
    return '';
  }
}

async function loadPresaleAttachment(orderId) {
  if (!orderId) return null;
  const supabase = getPortalAdminClient();
  const metaPath = `orders/presale/${orderId}.json`;
  const { data: metaBlob, error: metaError } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(metaPath);
  if (metaError) return null;
  const meta = JSON.parse(await metaBlob.text());
  const { data: fileBlob, error: fileError } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(meta.storagePath);
  if (fileError) return null;
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  return {
    name: meta.filename || `presale-invoice-${orderId}.pdf`,
    content: buffer.toString('base64'),
  };
}

/** Download the order confirmation PDF the browser uploaded via signed URL. */
async function loadConfirmationAttachment(storagePath, name) {
  if (!storagePath) return null;
  const supabase = getPortalAdminClient();
  const { data, error } = await supabase.storage.from(SITE_CONFIG_BUCKET).download(storagePath);
  if (error) return null;
  const buffer = Buffer.from(await data.arrayBuffer());
  return { name, content: buffer.toString('base64') };
}

function buildEmailHtml({
  customerName,
  orderNumber,
  orderDate,
  items,
  autoNotes,
  userNotes,
  customerNotes = '',
  assignedTo,
  total,
  hasPrices = false,
  hasPresaleInvoice,
  customerDetails = [],
}) {
  const dateStr = orderDate
    ? new Date(orderDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const showPrices = hasPrices && items.some((item) => !item.removed);
  const noteSections = buildOrderNoteSections({ assignedTo, autoNotes, userNotes, customerNotes });

  const customerBlock = customerDetails.length ? `
    <div style="margin:0 0 22px;padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
      ${customerDetails.map((row) => {
        const isDelivery = row.label === 'Delivery';
        return `
        <div style="margin-bottom:10px;font-size:14px;line-height:1.5${isDelivery ? ';padding:10px 12px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px' : ''}">
          <span style="color:${isDelivery ? '#9a3412' : '#64748b'};font-weight:700">${escapeHtml(row.label)}:</span>
          <span style="color:#0f172a;margin-left:6px;font-weight:${isDelivery ? '800' : '600'}">${escapeHtml(row.value)}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  const itemRows = items.map((item) => {
    const imgUrl = safeImageUrl(item.image);
    const stockQty = item.removed ? 0 : (item.qty ?? 0);
    if (item.removed) {
      return `
        <tr style="background:#fff5f5;border-bottom:1px solid #fee2e2;">
          <td style="padding:10px 12px">
            ${imgUrl ? `<img src="${imgUrl}" alt="" style="width:52px;height:52px;object-fit:contain;border-radius:6px;background:#f3f4f6">` : '<div style="width:52px;height:52px;background:#f3f4f6;border-radius:6px"></div>'}
          </td>
          <td style="padding:12px;font-weight:700;font-size:12px;color:#94a3b8;text-decoration:line-through">${escapeHtml(item.code, '—')}</td>
          <td style="padding:12px;font-size:14px;color:#94a3b8;text-decoration:line-through;line-height:1.45">${escapeHtml(item.name, '—')}</td>
          <td style="padding:12px;text-align:center;font-size:13px;color:#94a3b8;text-decoration:line-through">${item.originalQty ?? item.qty}</td>
          <td style="padding:12px;text-align:center"><span style="font-size:11px;font-weight:700;color:#dc2626;background:#fee2e2;padding:4px 10px;border-radius:6px">0</span></td>
          ${showPrices ? '<td style="padding:12px;text-align:right;color:#94a3b8">—</td>' : ''}
        </tr>`;
    }
    const qtyChanged = item.originalQty != null && item.qty !== item.originalQty;
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);
    const lineTotal = showPrices ? (item.qty * unitPrice).toFixed(2) : null;
    return `
      <tr style="background:${qtyChanged ? '#fffbeb' : 'transparent'};border-bottom:1px solid #f1f5f9;">
        <td style="padding:10px 12px">
          ${imgUrl ? `<img src="${imgUrl}" alt="" style="width:52px;height:52px;object-fit:contain;border-radius:6px;background:#f3f4f6">` : '<div style="width:52px;height:52px;background:#f3f4f6;border-radius:6px"></div>'}
        </td>
        <td style="padding:12px;font-weight:700;font-size:12px;color:#666666">${escapeHtml(item.code, '—')}</td>
        <td style="padding:12px;font-size:14px;color:#111111;font-weight:600;line-height:1.45">
          ${escapeHtml(item.name, '—')}
          ${item.swapped ? '<span style="display:inline-block;margin-top:6px;font-size:10px;font-weight:700;color:#2563eb;background:#dbeafe;padding:3px 8px;border-radius:4px">SUBSTITUTED</span>' : ''}
          ${qtyChanged ? '<span style="display:inline-block;margin-top:6px;font-size:10px;font-weight:700;color:#92400e;background:#fef3c7;padding:3px 8px;border-radius:4px">QTY CHANGED</span>' : ''}
        </td>
        <td style="padding:12px;text-align:center;font-size:13px;color:#94a3b8">${item.originalQty != null ? item.originalQty : item.qty}</td>
        <td style="padding:12px;text-align:center;font-weight:800;font-size:14px;color:#0f172a">${stockQty}</td>
        ${lineTotal != null ? `<td style="padding:12px;text-align:right;font-size:13px">R${lineTotal}</td>` : ''}
      </tr>`;
  }).join('');

  const notesHtml = noteSections.map((section) => {
    const isExtra = section.title === 'Additional notes' || section.title === 'Customer notes';
    return `
    <div style="margin-top:${isExtra ? '28px' : '20px'};padding:${isExtra ? '18px 20px' : '14px 16px'};background:${isExtra ? '#fffbeb' : '#f8fafc'};border-radius:10px;border:1px solid ${isExtra ? '#fde68a' : '#e2e8f0'};${isExtra ? 'border-left:4px solid #f59e0b' : ''}">
      <div style="font-size:12px;font-weight:800;color:${isExtra ? '#92400e' : '#64748b'};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px">${escapeHtml(section.title)}</div>
      <div style="display:grid;gap:10px">
        ${section.lines.map((line) => `
          <div style="font-size:14px;color:#1f2937;line-height:1.6;padding:10px 12px;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
            ${escapeHtml(line)}
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${escapeHtml(orderNumber)} — Proto Trading</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:640px;margin:24px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08)">

  <div style="background:#111111;padding:0">
    <div style="height:4px;background:#c40000"></div>
    <div style="padding:24px 32px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div style="display:flex;align-items:center;gap:14px;min-width:0">
        <img src="https://admin.proto.co.za/proto-logo.png" width="44" height="44" alt="Proto Trading" style="display:block;border-radius:8px;flex-shrink:0">
        <div style="min-width:0">
          <div style="font-size:18px;font-weight:800;line-height:1.2;letter-spacing:0.02em">
            <span style="color:#ffffff">PROTO</span><span style="color:#dc2626"> TRADING</span>
          </div>
          <div style="color:#94a3b8;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin-top:4px">Order Confirmation</div>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="color:#ffffff;font-size:15px;font-weight:800">${escapeHtml(orderNumber)}</div>
        ${dateStr ? `<div style="color:#94a3b8;font-size:12px;font-weight:600;margin-top:4px">${dateStr}</div>` : ''}
      </div>
    </div>
  </div>

  <div style="padding:28px 32px;background:#ffffff">
    <p style="color:#0f172a;font-size:15px;margin:0 0 8px">Hi <strong>${escapeHtml(customerName, 'there')}</strong>,</p>
    <p style="color:#334155;font-size:14px;margin:0 0 24px;line-height:1.65">
      Thank you for your order. Your confirmed summary is below and your
      <strong>order confirmation PDF</strong> is attached${hasPresaleInvoice ? ', together with your <strong>presale invoice</strong>' : ''}.
      ${items.some((i) => i.removed) ? '<br><span style="display:inline-block;margin-top:10px;color:#dc2626;font-weight:700;font-size:13px">Items with stock available 0 are not included in your confirmed order.</span>' : ''}
      ${items.some((i) => !i.removed && i.originalQty != null && i.qty !== i.originalQty) ? '<br><span style="display:inline-block;margin-top:8px;color:#92400e;font-weight:700;font-size:13px">Items marked QTY CHANGED have been adjusted from your original order.</span>' : ''}
    </p>

    ${customerBlock}

    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <thead>
        <tr>
          <th style="padding:12px;text-align:left;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;width:60px;background:#111111;border-bottom:2px solid #c40000">Img</th>
          <th style="padding:12px;text-align:left;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;background:#111111;border-bottom:2px solid #c40000">Code</th>
          <th style="padding:12px;text-align:left;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;background:#111111;border-bottom:2px solid #c40000">Product</th>
          <th style="padding:12px;text-align:center;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;background:#111111;border-bottom:2px solid #c40000">Ordered</th>
          <th style="padding:12px;text-align:center;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;background:#c40000;border-bottom:2px solid #c40000">Stock<br>Available</th>
          ${showPrices ? '<th style="padding:12px;text-align:right;font-size:10px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:0.06em;background:#111111;border-bottom:2px solid #c40000">Total</th>' : ''}
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    ${showPrices && total != null ? `
    <div style="margin-top:16px;padding:14px 12px;background:#fafafa;border-radius:8px;border:1px solid #e5e5e5;border-left:4px solid #c40000;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:14px;font-weight:700;color:#111111">Total (incl. VAT)</span>
      <span style="font-size:20px;font-weight:900;color:#c40000">R ${Number(total).toFixed(2)}</span>
    </div>` : ''}

    ${notesHtml}

    <div style="margin-top:20px;padding:14px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:13px;color:#9a3412;line-height:1.55">
      <strong style="display:block;margin-bottom:4px;color:#7c2d12">Attachments</strong>
      Order confirmation (PDF)${hasPresaleInvoice ? ' · Presale invoice' : ''}
    </div>

    <p style="margin:28px 0 0;font-size:14px;color:#475569;line-height:1.65">
      Thank you for choosing Proto Trading. Reply to this email if you have any questions.
    </p>
  </div>

  <div style="padding:22px 32px;background:#0f172a;text-align:center">
    <div style="font-size:13px;color:#ffffff;font-weight:700">Proto Trading · South Africa</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:6px">online@proto.co.za</div>
  </div>
</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  const auth = await requireAdminOrOrderToken(req, res);
  if (!auth) return;
  // This is the customer-facing send. `senderUserId`/`senderName` below are
  // browser-supplied display metadata, so they can never stand in for an
  // account — a fulfilment link must not reach this route at all.
  if (!requireAdminAuthType(auth, res, 'Fulfilment links cannot email customers. Sign in to the admin dashboard.')) return;
  if (req.method !== 'POST') return res.status(405).end();

  const {
    to,
    orderId,
    customerName,
    companyName,
    orderNumber,
    orderDate,
    items = [],
    autoNotes: autoNotesBody,
    userNotes,
    customerNotes: bodyCustomerNotes,
    assignedTo,
    total,
    hasPrices = false,
    pdfBase64,
    pdfFilename,
    confirmationStoragePath,
    senderUserId,
    senderName,
    deliveryMethod: bodyDeliveryMethod,
  } = req.body || {};

  if (!to) return res.status(400).json({ error: 'Recipient email (to) is required.' });

  if (!isVictorSender({ userId: senderUserId, name: senderName })) {
    return res.status(403).json({ error: CUSTOMER_SEND_FORBIDDEN });
  }

  if (!process.env.BREVO_API_KEY) {
    return res.status(500).json({ error: 'Brevo API key not configured (BREVO_API_KEY).' });
  }

  const confirmationName = pdfFilename || `proto-order-confirmation-${orderNumber || orderId || 'order'}.pdf`;

  // Prefer the PDF uploaded to storage via signed URL (no request-size limit).
  // Fall back to inlined base64 for older clients.
  let confirmationAttachment = await loadConfirmationAttachment(confirmationStoragePath, confirmationName);
  if (!confirmationAttachment && pdfBase64) {
    confirmationAttachment = { name: confirmationName, content: pdfBase64 };
  }
  if (!confirmationAttachment) {
    return res.status(400).json({ error: 'Order confirmation PDF is required.' });
  }

  const presaleAttachment = await loadPresaleAttachment(orderId);
  const attachments = [confirmationAttachment];
  if (presaleAttachment) attachments.push(presaleAttachment);

  let orderRow = null;
  if (orderId) {
    const supabase = getAdminClient();
    const { data } = await supabase
      .from('orders')
      .select('*, customers(name, contact_name, email, phone, business_name, business_type, city, province, country, company_address, delivery_address, vat_number, customer_code, tier)')
      .eq('id', orderId)
      .maybeSingle();
    orderRow = data;
  }

  // A per-order fulfillment link (order token) may ONLY send the confirmation
  // to that order's own customer — never to an arbitrary address. Admins
  // (verified session) can send anywhere (e.g. resend to a corrected email).
  if (auth.type === 'order') {
    const orderEmail = String(
      orderRow?.customers?.email || orderRow?.customer_email || orderRow?.email || '',
    ).trim().toLowerCase();
    if (!orderEmail || orderEmail !== String(to).trim().toLowerCase()) {
      return res.status(403).json({ error: "This order link can only email the order's own customer." });
    }
  }

  const autoNotes = autoNotesBody || deriveAutoNotesFromItems(items).join('\n');
  const customerDetails = customerDetailRows({
    ...(orderRow || {}),
    delivery_method: orderRow?.delivery_method || bodyDeliveryMethod,
    customers: orderRow?.customers || { name: customerName, business_name: companyName, email: to },
  });

  const html = buildEmailHtml({
    customerName: orderRow?.customers?.contact_name || orderRow?.customers?.name || customerName,
    orderNumber,
    orderDate: orderDate || orderRow?.created_at,
    items,
    autoNotes,
    userNotes,
    customerNotes: orderRow?.customer_notes || bodyCustomerNotes || '',
    assignedTo,
    total,
    hasPrices,
    hasPresaleInvoice: Boolean(presaleAttachment),
    customerDetails,
  });

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'Proto Trading', email: process.env.BREVO_SENDER_EMAIL || 'online@proto.co.za' },
      to: [{ email: to }],
      subject: `Your Order Confirmation ${orderNumber || ''} — Proto Trading`.trim(),
      htmlContent: html,
      attachment: attachments,
    }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    return res.status(502).json({ error: body.message || 'Email could not be sent' });
  }

  if (orderId) {
    try {
      await markConfirmationSent(orderId);
    } catch (err) {
      console.error('send-order-email: failed to mark confirmation sent:', err.message);
    }
  }

  // Stamp the customer's "last email sent" status (best-effort, analytics only).
  try {
    const sb = createClient(
      process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await markCustomerEmailed(sb, { email: to, type: 'order_confirmation' });
  } catch { /* best effort */ }

  return res.status(200).json({
    ok: true,
    attachments: attachments.map((a) => a.name),
    presaleIncluded: Boolean(presaleAttachment),
  });
}
