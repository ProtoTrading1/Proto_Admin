export async function fetchConfirmationSent(orderIds = []) {
  const ids = orderIds.filter(Boolean);
  if (!ids.length) return {};
  const res = await fetch(`/api/order-confirmation-sent?ids=${encodeURIComponent(ids.join(','))}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load confirmation status');
  return json.confirmations || {};
}

export async function markConfirmationSent(orderId) {
  const res = await fetch('/api/order-confirmation-sent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to mark confirmation sent');
  return json;
}

export async function fetchPaymentRecords(orderIds = []) {
  const ids = orderIds.filter(Boolean);
  if (!ids.length) return {};
  const res = await fetch(`/api/order-pop?ids=${encodeURIComponent(ids.join(','))}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load payment records');
  return json.pops || {};
}

export async function uploadPop(orderId, file, { paid = true } = {}) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await fetch('/api/order-pop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId,
      fileBase64: base64,
      filename: file.name,
      contentType: file.type || 'application/pdf',
      paid,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Upload failed');
  return json;
}

export async function setPaymentStatus(orderId, paid) {
  const res = await fetch('/api/order-pop', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, paid }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update payment status');
  return json;
}
