export async function fetchOrdersPage({
  page = 1,
  pageSize = 50,
  search = '',
  tab = 'all',
} = {}) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    tab,
    search,
  });
  const res = await fetch(`/api/admin-orders?${params}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to fetch orders');
  return {
    rows: json.rows || [],
    total: json.total || 0,
    page: json.page || page,
    pageSize: json.pageSize || pageSize,
    tabCounts: json.tabCounts || null,
    orderTrashEnabled: json.capabilities?.orderTrash === true,
  };
}

export async function updateOrderAdmin(id, fields) {
  const res = await fetch('/api/admin-orders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...fields }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update order');
  return json.row;
}

export async function advanceOrderWorkflow(id, advanceWorkflow, { senderUserId, senderName } = {}) {
  const res = await fetch('/api/admin-orders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, advanceWorkflow, senderUserId, senderName }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to advance order status');
  return json.row;
}

export async function deleteOrderAdmin(id, reason) {
  const res = await fetch('/api/admin-orders', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, reason }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete order');
}

export async function restoreOrderAdmin(trashId) {
  const res = await fetch('/api/admin-orders', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restoreTrashId: trashId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to restore order');
  return json;
}
