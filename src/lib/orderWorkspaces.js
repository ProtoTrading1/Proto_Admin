import { readApiJson } from './apiError';

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return readApiJson(res, { fallback: 'Order workspace request failed' });
}

export async function listOrderWorkspaces({ search = '', limit = 30 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (search) qs.set('search', search);
  const json = await request(`/api/order-workspaces?${qs}`);
  return json.rows || [];
}

export async function fetchOrderWorkspace(id) {
  const json = await request(`/api/order-workspaces?id=${encodeURIComponent(id)}`);
  return json.row;
}

export async function createOrderWorkspace({ command = '', customerQuery = '', customerId = '' } = {}) {
  const json = await request('/api/order-workspaces', {
    method: 'POST',
    body: JSON.stringify({ command, customerQuery, customerId }),
  });
  return json.row;
}

export async function updateOrderWorkspace(id, fields) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'update', ...fields }),
  });
  return json.row;
}

export async function changeOrderWorkspaceStatus(id, status) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'change_status', status }),
  });
  return json.row;
}

export async function addOrderWorkspaceLine(id, line) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'add_line', line }),
  });
  return json.row;
}

export async function addOrderWorkspaceTask(id, task) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'add_task', ...task }),
  });
  return json.row;
}

export async function completeOrderWorkspaceTask(id, taskId) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'complete_task', taskId }),
  });
  return json.row;
}

export async function addOrderWorkspacePromise(id, promise) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'add_promise', ...promise }),
  });
  return json.row;
}

export async function addOrderWorkspaceReminder(id, reminder) {
  const json = await request('/api/order-workspaces', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'add_reminder', ...reminder }),
  });
  return json.row;
}

