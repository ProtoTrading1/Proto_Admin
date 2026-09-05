import { loadJsPDF } from './lazyJspdf';
import { displayOrderNumber, buildFulfillmentUrl } from './orderNumber';
import {
  buildOrderNoteSections,
  pdfShippingMethod,
  invoiceToLines,
  deliveryAddressLines,
} from '../../lib/order-format.mjs';

/** Customer-facing order confirmation PDF/email — staff preview may still show prices. */
export const SHOW_CUSTOMER_PRICES = false;

export { buildOrderNoteSections, deriveAutoNotesFromItems, resolveDeliveryMethod, formatDeliveryMethod, pdfShippingMethod } from '../../lib/order-format.mjs';

export function stripPricesFromOrderItems(items = []) {
  return items.map(({ unitPrice, price, ...rest }) => rest);
}

export function resolveCustomerOrderPricing(items = []) {
  if (!SHOW_CUSTOMER_PRICES) {
    return { hasPrices: false, total: null, items: stripPricesFromOrderItems(items) };
  }
  const hasPrices = items.some((item) => item.unitPrice != null || item.price != null);
  const total = hasPrices
    ? items
      .filter((item) => !item.removed)
      .reduce((sum, item) => sum + (Number(item.unitPrice ?? item.price ?? 0) * (item.qty || 0)), 0)
    : null;
  return { hasPrices, total, items };
}

export function buildCombinedNotes(payload = {}) {
  return buildOrderNoteSections(payload)
    .map((section) => `${section.title}:\n${section.lines.map((line) => `• ${line}`).join('\n')}`)
    .join('\n\n');
}

export function createEmailOrderItems(items = []) {
  return items.map(({ finalQty, qty, removed, swapped, originalCode, originalName, ...rest }) => ({
    ...rest,
    qty: removed ? qty : finalQty,
    originalQty: qty,
    removed: removed || false,
    swapped: swapped || false,
    originalCode,
    originalName,
  }));
}

/** Reconciliation key for one order line. Not guaranteed unique across lines. */
export function orderLineKey(item) {
  const productId = String(item?.productId ?? '').trim();
  const code = String(item?.code ?? '').trim();
  return productId || code;
}

/** Compare original vs final order rows for email/PDF when sending from the admin list. */
export function buildEmailItemsFromOrder(order) {
  const original = Array.isArray(order?.original_items) ? order.original_items : (Array.isArray(order?.items) ? order.items : []);
  const final = Array.isArray(order?.final_items) ? order.final_items : original;

  // Keys can legitimately collide (two lines sharing a barcode) — a plain Map
  // would keep only the last line and silently drop or duplicate rows on the
  // confirmation. Group final rows per key and consume one per matching
  // original so duplicate keys pair one-to-one; unconsumed rows are additions.
  const finalByKey = new Map();
  final.forEach((it) => {
    const key = orderLineKey(it);
    const bucket = finalByKey.get(key);
    if (bucket) bucket.push(it);
    else finalByKey.set(key, [it]);
  });
  const takeFinal = (key) => {
    const bucket = finalByKey.get(key);
    if (!bucket?.length) return undefined;
    const fin = bucket.shift();
    if (!bucket.length) finalByKey.delete(key);
    return fin;
  };

  const rows = original.map((orig) => {
    const fin = takeFinal(orderLineKey(orig));
    const removed = !fin;
    return {
      ...orig,
      qty: removed ? orig.qty : (fin.qty ?? orig.qty),
      finalQty: removed ? 0 : (fin.qty ?? orig.qty),
      originalQty: orig.qty,
      removed,
      swapped: Boolean(fin?.swapped),
      originalCode: fin?.originalCode,
      originalName: fin?.originalName,
      unitPrice: fin?.unitPrice ?? fin?.price ?? orig.unitPrice ?? orig.price ?? 0,
      image: fin?.image ?? orig.image ?? '',
    };
  });

  for (const bucket of finalByKey.values()) {
    bucket.forEach((fin) => {
      rows.push({
        ...fin,
        qty: fin.qty,
        finalQty: fin.qty,
        originalQty: fin.qty,
        removed: false,
        swapped: true,
        unitPrice: fin.unitPrice ?? fin.price ?? 0,
      });
    });
  }

  return rows;
}

function money(value) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(value || 0));
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// Images render at 44pt in the PDF, so embedding full-resolution source images
// just bloats the file (and used to push the email payload past size limits).
// Downscale to a small JPEG before embedding.
async function loadImageDataUrl(url, maxPx = 160) {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return await blobToDataUrl(blob);

    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

// The built-in PDF fonts only cover CP1252, so characters like → or smart
// quotes (which arrive in customer notes / auto-notes) render garbled or throw
// off letter spacing. Map the common ones to safe ASCII before drawing.
function pdfSafeText(value) {
  return String(value ?? '')
    .replace(/[→➔➜]/g, '->')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...');
}

/** Uppercase customer identity/address lines for copy-paste shipping labels. */
export function uppercasePdfCustomerDetails(lines = []) {
  return lines.map((line) => String(line ?? '').toLocaleUpperCase('en-ZA'));
}

function detectImageFormat(dataUrl) {
  if (!dataUrl) return 'JPEG';
  if (dataUrl.includes('image/png')) return 'PNG';
  if (dataUrl.includes('image/webp')) return 'WEBP';
  return 'JPEG';
}

// Packing-slip column layout: #  Image  Barcode  Product  Qty  Avail
// Column layout. The admin/picking copy prepends a dedicated tick-box column
// and keeps the line-number column; the customer copy omits the tick column.
function columnsFor(checkboxes) {
  if (checkboxes) {
    return {
      check: { x: 40, w: 20 },
      num: { x: 62, w: 14 },
      img: { x: 80, w: 42 },
      code: { x: 128, w: 72 },
      name: { x: 204, w: 200 },
      qty: { x: 410, w: 52 },
      avail: { x: 464, w: 91 },
    };
  }
  return {
    num: { x: 40, w: 20 },
    img: { x: 62, w: 44 },
    code: { x: 112, w: 80 },
    name: { x: 196, w: 212 },
    qty: { x: 410, w: 52 },
    avail: { x: 464, w: 91 },
  };
}

function colCenter(col) {
  return col.x + col.w / 2;
}

const ROW_LINE = 12;
const ROW_PAD = 18;

export async function generateOrderPdfBase64({
  order,
  items = [],
  autoNotes = '',
  userNotes = '',
  assignedTo = '',
  total = null,
  hasPrices = false,
  includeInternalLink = false,
  fulfillmentUrl = '',
  // Admin/picking variant draws an empty tick box on each line. The customer
  // copy leaves this false so their confirmation has no checkboxes.
  checkboxes = false,
}) {
  const COL = columnsFor(checkboxes);
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed = 24) => {
    if (y + needed <= pageHeight - margin) return;
    doc.addPage();
    y = margin;
  };

  const orderNumber = displayOrderNumber(order);
  const dateStr = new Date(order?.created_at || Date.now()).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const linkUrl = includeInternalLink ? (fulfillmentUrl || buildFulfillmentUrl(order?.id)) : '';
  const shippingMethod = pdfShippingMethod(order);
  const invoiceLines = uppercasePdfCustomerDetails(invoiceToLines(order));
  const deliverLines = uppercasePdfCustomerDetails(deliveryAddressLines(order));

  // ── Header band — Proto Trading Online ──────────────────────────────────
  doc.setFillColor(196, 0, 0);
  doc.rect(0, 0, pageWidth, 5, 'F');
  doc.setFillColor(11, 11, 11);
  doc.rect(0, 5, pageWidth, 110, 'F');

  const logoData = await loadImageDataUrl('/proto-logo.png');
  let brandX = margin;
  if (logoData) {
    try { doc.addImage(logoData, detectImageFormat(logoData), margin, 30, 46, 46); brandX = margin + 58; } catch { brandX = margin; }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(255, 255, 255);
  doc.text('PROTO', brandX, 46);
  const protoW = doc.getTextWidth('PROTO');
  doc.setTextColor(224, 0, 0);
  doc.text(' TRADING', brandX + protoW, 46);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(217, 155, 61);
  doc.setCharSpace(4);
  doc.text('ONLINE', brandX + 1, 66);
  doc.setCharSpace(0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.setCharSpace(1.4);
  doc.text('ORDER CONFIRMATION', brandX, 84);
  doc.setCharSpace(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text(orderNumber, pageWidth - margin, 46, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(150, 150, 150);
  doc.text(dateStr, pageWidth - margin, 64, { align: 'right' });
  y = 138;

  // ── Shipping method banner ──────────────────────────────────────────────
  ensureSpace(28);
  doc.setFillColor(255, 247, 237);
  doc.setDrawColor(217, 155, 61);
  doc.setLineWidth(1);
  doc.roundedRect(margin, y, contentWidth, 28, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(146, 64, 14);
  doc.setCharSpace(0.6);
  doc.text('SHIPPING METHOD', margin + 12, y + 17);
  doc.setCharSpace(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(shippingMethod, margin + 128, y + 18);
  y += 44;

  // ── Invoice To + Delivery Address (two columns) ─────────────────────────
  ensureSpace(130);
  const gap = 16;
  const blockW = (contentWidth - gap) / 2;
  const rightX = margin + blockW + gap;

  const drawAddressBlock = (title, lines, bx, startY) => {
    let yy = startY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(196, 0, 0);
    doc.setCharSpace(0.5);
    doc.text(title.toUpperCase(), bx, yy);
    doc.setCharSpace(0);
    yy += 15;
    lines.forEach((line, i) => {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(i === 0 ? 10 : 9);
      doc.setTextColor(i === 0 ? 15 : 55, i === 0 ? 23 : 65, i === 0 ? 42 : 81);
      const wrapped = doc.splitTextToSize(String(line), blockW);
      wrapped.forEach((wl) => { doc.text(wl, bx, yy); yy += 13; });
    });
    return yy;
  };

  const blockStartY = y;
  const leftEnd = drawAddressBlock('Invoice To', invoiceLines, margin, blockStartY);
  const rightEnd = drawAddressBlock('Delivery Address', deliverLines, rightX, blockStartY);
  y = Math.max(leftEnd, rightEnd) + 14;

  // ── Table header (redrawn on every page) ────────────────────────────────
  const drawTableHeader = () => {
    doc.setFillColor(11, 11, 11);
    doc.rect(margin, y, contentWidth, 24, 'F');
    doc.setFillColor(196, 0, 0);
    doc.rect(COL.avail.x - 4, y, COL.avail.w + 4, 24, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    if (checkboxes) {
      doc.setFontSize(6.5);
      doc.text('PACK', COL.check.x, y + 15);
      doc.setFontSize(7.5);
    }
    doc.text('#', COL.num.x, y + 15);
    doc.text('IMAGE', COL.img.x, y + 15);
    doc.text('BARCODE', COL.code.x, y + 15);
    doc.text('PRODUCT', COL.name.x, y + 15);
    doc.text('QTY', colCenter(COL.qty), y + 15, { align: 'center' });
    doc.text('AVAIL', colCenter(COL.avail), y + 15, { align: 'center' });
    y += 32;
  };
  ensureSpace(34);
  drawTableHeader();

  // ── Line items ────────────────────────────────────────────────────────
  let rowIndex = 0;
  for (const item of items) {
    rowIndex += 1;
    const orderedQty = item.originalQty != null ? item.originalQty : item.qty;
    const confirmedQty = item.removed ? 0 : (item.qty ?? item.finalQty ?? 0);
    const codeText = String(item.code || '—');
    const nameText = String(item.name || '—');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    const codeLines = doc.splitTextToSize(codeText, COL.code.w).slice(0, 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const nameLines = doc.splitTextToSize(nameText, COL.name.w).slice(0, 3);
    const textLines = Math.max(1, codeLines.length, nameLines.length);
    const rowH = Math.max(54, ROW_PAD + textLines * ROW_LINE);

    // Page break — carry the column header onto the new page.
    if (y + rowH + 8 > pageHeight - margin) {
      doc.addPage();
      y = margin;
      drawTableHeader();
    }

    if (item.removed) doc.setFillColor(255, 245, 245);
    else if (orderedQty !== confirmedQty) doc.setFillColor(255, 251, 235);
    else doc.setFillColor(255, 255, 255);
    doc.rect(margin, y - 2, contentWidth, rowH, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y + rowH - 2, margin + contentWidth, y + rowH - 2);

    // Dedicated tick-box column on the admin/picking copy.
    if (checkboxes) {
      const box = 14;
      const bx = COL.check.x + (COL.check.w - box) / 2;
      const by = y + rowH / 2 - box / 2;
      doc.setDrawColor(90, 90, 90);
      doc.setLineWidth(1.1);
      doc.roundedRect(bx, by, box, box, 2, 2, 'S');
    }
    // Line number (both copies).
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(String(rowIndex), COL.num.x, y + rowH / 2 + 3);

    // image
    const imgData = await loadImageDataUrl(item.image);
    const imgY = y + (rowH - 44) / 2;
    if (imgData) {
      try {
        doc.addImage(imgData, detectImageFormat(imgData), COL.img.x, imgY, 44, 44);
      } catch {
        doc.setFillColor(243, 244, 246);
        doc.rect(COL.img.x, imgY, 44, 44, 'F');
      }
    } else {
      doc.setFillColor(243, 244, 246);
      doc.rect(COL.img.x, imgY, 44, 44, 'F');
    }

    const textY = y + 16;
    // barcode / code
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(item.removed ? 148 : 71, item.removed ? 163 : 85, item.removed ? 184 : 105);
    doc.text(codeLines, COL.code.x, textY, { maxWidth: COL.code.w, lineHeightFactor: 1.15 });
    // product name
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(item.removed ? 148 : 15, item.removed ? 163 : 23, item.removed ? 184 : 42);
    doc.text(nameLines, COL.name.x, textY, { maxWidth: COL.name.w, lineHeightFactor: 1.15 });

    if (item.removed) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(220, 38, 38);
      doc.text('OUT OF STOCK', COL.name.x, textY + nameLines.length * ROW_LINE + 2);
    } else if (item.swapped) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(37, 99, 235);
      doc.text('SUBSTITUTED', COL.name.x, textY + nameLines.length * ROW_LINE + 2);
    } else if (orderedQty !== confirmedQty) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(146, 64, 14);
      doc.text('QTY CHANGED', COL.name.x, textY + nameLines.length * ROW_LINE + 2);
    }

    // qty (ordered) + avail (available)
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text(String(orderedQty), colCenter(COL.qty), y + rowH / 2 + 3, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(item.removed ? 220 : 15, item.removed ? 38 : 23, item.removed ? 38 : 42);
    doc.text(item.removed ? '0' : String(confirmedQty), colCenter(COL.avail), y + rowH / 2 + 3, { align: 'center' });

    y += rowH;
  }

  if (hasPrices && total != null) {
    ensureSpace(36);
    y += 8;
    doc.setFillColor(255, 255, 255);
    doc.rect(margin, y, contentWidth, 28, 'F');
    doc.setDrawColor(229, 229, 229);
    doc.rect(margin, y, contentWidth, 28, 'S');
    doc.setFillColor(196, 0, 0);
    doc.rect(margin, y, 4, 28, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(17, 17, 17);
    doc.text('Order total (incl. VAT)', margin + 12, y + 18);
    doc.setTextColor(17, 17, 17);
    doc.text(money(total), margin + contentWidth - 12, y + 18, { align: 'right' });
    y += 40;
  }

  const noteSections = buildOrderNoteSections({
    assignedTo: '',
    autoNotes,
    userNotes,
    customerNotes: order?.customer_notes || '',
  });
  const changeSection = noteSections.find((s) => s.title === 'Order changes');
  const extraSection = noteSections.find((s) => s.title === 'Additional notes');
  const customerNotesSection = noteSections.find((s) => s.title === 'Customer notes');
  const handledSection = noteSections.find((s) => s.title === 'Handled by');

  const renderNoteBlock = (section, { emphasize = false } = {}) => {
    if (!section?.lines?.length) return;
    ensureSpace(48);
    doc.setFillColor(emphasize ? 255 : 248, emphasize ? 251 : 250, emphasize ? 235 : 252);
    doc.setDrawColor(emphasize ? 251 : 226, emphasize ? 191 : 232, emphasize ? 36 : 240);
    const blockH = 28 + section.lines.length * 16;
    ensureSpace(blockH);
    doc.roundedRect(margin, y, contentWidth, blockH, 4, 4, emphasize ? 'FD' : 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(emphasize ? 12 : 11);
    doc.setTextColor(15, 23, 42);
    doc.text(section.title, margin + 12, y + 18);
    y += 28;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(55, 65, 81);
    section.lines.forEach((line) => {
      const lines = doc.splitTextToSize(pdfSafeText(line), contentWidth - 28);
      lines.forEach((ln) => {
        ensureSpace(16);
        doc.text(ln, margin + 14, y, { maxWidth: contentWidth - 28 });
        y += 15;
      });
    });
    y += 14;
  };

  if (handledSection) renderNoteBlock(handledSection);
  if (customerNotesSection) renderNoteBlock(customerNotesSection, { emphasize: true });
  if (changeSection) renderNoteBlock(changeSection);
  if (extraSection) {
    y += 8;
    renderNoteBlock(extraSection, { emphasize: true });
  }

  if (linkUrl) {
    ensureSpace(36);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text('Reopen this order in the fulfilment tab:', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(37, 99, 235);
    const linkLines = doc.splitTextToSize(linkUrl, contentWidth);
    linkLines.forEach((ln) => {
      ensureSpace(12);
      doc.text(ln, margin, y, { maxWidth: contentWidth });
      y += 12;
    });
    y += 8;
  }

  ensureSpace(30);
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  const footer = hasPrices
    ? 'Proto Trading · South Africa · All prices incl. VAT'
    : 'Proto Trading · South Africa';
  doc.text(footer, margin, pageHeight - margin);

  return doc.output('datauristring').split(',')[1];
}

/** Convert a base64 string into a Blob (for direct uploads / object URLs). */
export function base64ToBlob(base64, type = 'application/pdf') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Open a base64 PDF in a new tab (avoids blocked data: URL fetches). */
export function openPdfBase64Preview(pdfBase64, filename = 'proto-order-preview.pdf') {
  const blob = base64ToBlob(pdfBase64, 'application/pdf');
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
