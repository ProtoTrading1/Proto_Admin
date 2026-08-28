import { createClient } from '@supabase/supabase-js';
import { PROTO_URLS } from './_proto-urls.js';
import { resolveOrderAlertRecipients } from './_order-alert-recipients.js';
import { sendBrevoTransactional } from './_brevo-email.js';
import { customerEmailIdentity } from './_order-format.js';
import {
  getPortalAdminClient,
  readOrderNotifyLog,
  writeOrderNotifyLog,
  SITE_CONFIG_BUCKET,
} from './_site-config.js';

// The whole team receives the new-order alert. Kept as a list so the cron
// sweep and the manual resend can recover the notification for EVERY required
// address, not just one. NEW_ORDER_ALERT_EMAIL may add recipients; it can no
// longer replace them.
export const NEW_ORDER_ALERT_EMAILS = resolveOrderAlertRecipients();

// Brevo rejects a message over ~10MB and base64 inflates the file by ~33%.
const MAX_ALERT_ATTACHMENT_BYTES = 6 * 1024 * 1024;
/** @deprecated Kept for log/message compatibility — prefer NEW_ORDER_ALERT_EMAILS. */
export const NEW_ORDER_ALERT_EMAIL = NEW_ORDER_ALERT_EMAILS.join(', ');

function getPortalDbClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function orderAmountExVat(order) {
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

function formatRand(value) {
  return `R ${Number(value || 0).toFixed(2)}`;
}

export function orderItems(order) {
  return (order?.original_items?.length ? order.original_items : null)
    || order?.items || [];
}

function orderPdfPath(orderId) {
  return `orders/${orderId}.pdf`;
}

async function loadStoredOrderPdf(orderId) {
  const supabase = getPortalAdminClient();
  const { data, error } = await supabase.storage
    .from(SITE_CONFIG_BUCKET)
    .download(orderPdfPath(orderId));
  if (error || !data) {
    throw new Error(error?.message || 'Stored order PDF is unavailable');
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (!bytes.length) throw new Error('Stored order PDF is empty');
  return bytes;
}

async function sendNewOrderAlertEmail(order, { resendCount = 0 } = {}) {
  const customer = order.customers || {};
  const { customerName, companyName } = customerEmailIdentity(customer);
  const customerLabel = customerName || companyName || 'Unknown customer';
  const companyLine = companyName
    ? `<br/><strong>Company:</strong> ${esc(companyName)}`
    : '';
  const subjectIdentity = [customerName, companyName].filter(Boolean).join(' - ') || 'Unknown';
  const orderNo = order.order_number || order.id;
  const amount = formatRand(orderAmountExVat(order));
  const placedAt = order.created_at
    ? new Date(order.created_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const items = orderItems(order);
  const itemRows = items.map((item, index) => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;">${index + 1}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;">${esc(item?.name || item?.title || item?.sku || '')}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;">${esc(item?.code || item?.sku || '')}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${esc(item?.qty ?? item?.quantity ?? '')}</td>
    </tr>`).join('');
  // The PDF is best-effort. It used to be awaited unguarded, so a missing or
  // oversized file threw and the team got NO alert at all — the failure mode
  // that cost PT_00099. The order details below are enough to act on; the PDF
  // is a convenience, not a precondition.
  let pdf = null;
  let pdfProblem = '';
  try {
    pdf = await loadStoredOrderPdf(order.id);
    if (pdf.length > MAX_ALERT_ATTACHMENT_BYTES) {
      pdfProblem = 'This order is too large to attach as a PDF.';
      pdf = null;
    }
  } catch (err) {
    pdfProblem = 'The order PDF is not available yet.';
    console.warn('order alert: stored PDF unavailable, sending without it', order.id, err?.message || err);
  }

  const htmlContent = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 8px;">${resendCount > 0 ? 'Resent order' : 'New order'} ${esc(orderNo)}</h2>
  <p style="margin:0 0 16px;color:#374151;">
    <strong>Customer:</strong> ${esc(customerLabel)}${companyLine}
    ${customer.email ? `<br/><strong>Email:</strong> ${esc(customer.email)}` : ''}<br/>
    ${placedAt ? `Placed ${esc(placedAt)} · ` : ''}Total <strong>${esc(amount)}</strong> ex VAT
  </p>
  <p style="font-size:13px;color:#374151;"><strong>${items.length}</strong> product line${items.length === 1 ? '' : 's'} · ${pdf ? 'complete order PDF attached.' : 'every line is listed below.'}</p>
  ${pdfProblem ? `<p style="margin:0 0 16px;padding:12px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:13px;"><strong>${esc(pdfProblem)}</strong> Open the order in the admin portal to download it.</p>` : ''}
  ${itemRows ? `<table style="border-collapse:collapse;width:100%;font-size:13px;"><tbody>${itemRows}</tbody></table>` : ''}
  <p style="margin:20px 0 0;">
    <a href="${PROTO_URLS.admin}" style="display:inline-block;background:#c40000;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;">Open admin portal</a>
  </p>
</body></html>`;

  const response = await sendBrevoTransactional({
    to: NEW_ORDER_ALERT_EMAILS.map((email) => ({ email, name: 'Proto Trading Orders' })),
    subject: `New order ${orderNo} — ${subjectIdentity} — ${amount}`,
    htmlContent,
    textContent: `New order ${orderNo}\nCustomer: ${customerLabel}${companyName ? `\nCompany: ${companyName}` : ''}${customer.email ? `\nEmail: ${customer.email}` : ''}\nTotal: ${amount} ex VAT.`,
    attachment: pdf ? [{
      name: `proto-order-${orderNo}.pdf`,
      content: pdf.toString('base64'),
    }] : undefined,
    headers: {
      'Idempotency-Key': `proto-admin-order-${order.id}-resend-${resendCount}`,
    },
  });
  return {
    messageId: response?.messageId || response?.message_id || null,
    pdfBytes: pdf?.length ?? 0,
    pdfAttached: Boolean(pdf),
    pdfProblem: pdfProblem || null,
    lineCount: items.length,
  };
}

export function appendAudit(log, event) {
  const history = Array.isArray(log?.deliveryHistory) ? log.deliveryHistory : [];
  return [...history, event].slice(-25);
}

export async function resendInternalOrderEmail(orderId, { actorEmail = null } = {}) {
  const supabase = getPortalDbClient();
  const { data: order, error } = await supabase
    .from('orders')
    .select('*, customers(name, contact_name, email, business_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order) throw new Error('Order not found');

  const previous = await readOrderNotifyLog(String(orderId)) || { orderId: String(orderId) };
  const resendCount = Number(previous.internalEmailResendCount || 0) + 1;
  const attemptedAt = new Date().toISOString();

  try {
    const result = await sendNewOrderAlertEmail(order, { resendCount });
    const next = {
      ...previous,
      found: true,
      emailSent: true,
      emailRecipients: NEW_ORDER_ALERT_EMAILS,
      alertEmail: NEW_ORDER_ALERT_EMAIL,
      emailMessageId: result.messageId,
      emailFailReason: null,
      emailProviderStatus: 201,
      emailPdfAttached: result.pdfAttached,
      emailPdfProblem: result.pdfProblem,
      emailPdfSource: result.pdfAttached ? 'stored-order-pdf' : null,
      pdfStored: result.pdfAttached,
      internalEmailResendCount: resendCount,
      internalEmailLastResentAt: attemptedAt,
      internalEmailLastResentBy: actorEmail,
      deliveryHistory: appendAudit(previous, {
        type: 'internal-email-resend',
        ok: true,
        at: attemptedAt,
        by: actorEmail,
        recipients: NEW_ORDER_ALERT_EMAILS,
        messageId: result.messageId,
        lineCount: result.lineCount,
        pdfBytes: result.pdfBytes,
      }),
      at: previous.at || attemptedAt,
    };
    await writeOrderNotifyLog(orderId, next);
    return { ok: true, orderId, resendCount, ...result, recipients: NEW_ORDER_ALERT_EMAILS };
  } catch (err) {
    await writeOrderNotifyLog(orderId, {
      ...previous,
      found: true,
      emailFailReason: err.message || 'Internal email resend failed',
      internalEmailResendCount: resendCount,
      internalEmailLastResentAt: attemptedAt,
      internalEmailLastResentBy: actorEmail,
      deliveryHistory: appendAudit(previous, {
        type: 'internal-email-resend',
        ok: false,
        at: attemptedAt,
        by: actorEmail,
        recipients: NEW_ORDER_ALERT_EMAILS,
        error: err.message || 'Internal email resend failed',
      }),
      at: previous.at || attemptedAt,
    });
    throw err;
  }
}

/**
 * A new order counts as fully notified once the new-order email went out and
 * the fulfilment PDF is stored. (WhatsApp/WATI notifications were removed —
 * email is the notification. Old logs may still carry WhatsApp fields; they
 * are ignored.)
 */
export function isOrderNotifyComplete(log) {
  if (!log || (!log.found && log.emailSent == null && log.sent == null)) {
    return { ok: false, reason: 'No new-order notification has been sent for this order yet' };
  }
  if (!log.emailSent) {
    return { ok: false, reason: `The new-order email to ${NEW_ORDER_ALERT_EMAIL} has not been sent yet` };
  }
  return { ok: true };
}
/**
 * Send the new-order email (once) and ask the main portal to store the
 * fulfilment PDF and advance the order's workflow status. (The portal endpoint
 * used to also fan out team WhatsApp — that automation is removed.)
 */
export async function notifyNewOrder(orderId) {
  const supabase = getPortalDbClient();
  const { data: order, error } = await supabase
    .from('orders')
    .select('*, customers(name, contact_name, email, business_name)')
    .eq('id', orderId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!order) return { ok: false, error: 'order_not_found' };

  const log = await readOrderNotifyLog(String(orderId));
  let emailSent = !!log?.emailSent;
  let emailError = null;
  if (!emailSent) {
    try {
      await sendNewOrderAlertEmail(order);
      emailSent = true;
    } catch (err) {
      emailError = err.message || 'email_failed';
    }
  }

  const secret = process.env.ORDER_NOTIFY_SECRET;
  if (!secret) {
    // No shared secret for the portal endpoint. Record an email-only round so
    // the order can still leave "New" on the strength of the alert email, and
    // the dashboard shows an honest status instead of an empty log.
    await writeOrderNotifyLog(orderId, {
      found: true,
      emailSent,
      emailError,
      alertEmail: NEW_ORDER_ALERT_EMAIL,
      whatsappNotConfigured: true,
      sent: 0,
      failed: 0,
      teamSize: 0,
      at: new Date().toISOString(),
    }).catch(() => {});
    return {
      ok: emailSent,
      emailSent,
      emailError,
      whatsappNotConfigured: true,
      error: emailSent ? null : (emailError || 'email_failed'),
    };
  }

  try {
    const resp = await fetch(`${PROTO_URLS.site}/api/orders/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-order-notify-secret': secret,
      },
      body: JSON.stringify({ orderId, emailSent }),
    });
    const data = await resp.json().catch(() => ({}));
    return { httpStatus: resp.status, ...data, emailSent, emailError };
  } catch (err) {
    return { ok: false, emailSent, emailError, error: err.message || 'Order notification failed' };
  }
}
