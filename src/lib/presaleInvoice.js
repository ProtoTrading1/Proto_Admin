export async function fetchPresaleInvoices(orderIds = []) {
  const ids = orderIds.filter(Boolean);
  if (!ids.length) return {};
  const res = await fetch(`/api/order-presale-invoice?ids=${encodeURIComponent(ids.join(','))}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load presale invoices');
  return json.invoices || {};
}

export async function uploadPresaleInvoice(orderId, file) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await fetch('/api/order-presale-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId,
      fileBase64: base64,
      filename: file.name,
      contentType: file.type || 'application/pdf',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Upload failed');
  return json;
}

export async function fetchPresaleInvoiceBase64(orderId) {
  const res = await fetch(`/api/order-presale-invoice?id=${encodeURIComponent(orderId)}`);
  const json = await res.json();
  const meta = json.invoices?.[orderId];
  if (!meta?.storagePath) return null;
  const fileRes = await fetch(`/api/order-presale-invoice-file?orderId=${encodeURIComponent(orderId)}`);
  if (!fileRes.ok) return null;
  const data = await fileRes.json();
  return data;
}
