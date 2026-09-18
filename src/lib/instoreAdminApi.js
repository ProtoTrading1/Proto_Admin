import { readApiJson } from './apiError.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function request(url, options = {}, fallback = 'Instore request failed') {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  return readApiJson(response, { fallback });
}

export async function fetchInstoreProducts({ status = 'live', q = '', page = 1, pageSize = 50 } = {}) {
  const params = new URLSearchParams({ status, q: String(q || ''), page: String(page), pageSize: String(pageSize) });
  return request(`/api/instore-admin?${params}`, {}, 'Could not load Instore Products');
}

export async function stageInstoreFile({ batchId, filename, imageBase64, contentType }) {
  return request('/api/instore-admin', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ action: 'stage', batchId, filename, imageBase64, contentType }),
  }, 'Could not stage Instore image');
}

export async function updateInstoreProduct({ sku, patch, version }) {
  return request('/api/instore-admin', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ action: 'update', sku, patch, version }),
  }, 'Could not update Instore product');
}

export async function mutateInstoreProduct(action, { sku, version } = {}) {
  if (!['sync', 'approve', 'archive', 'recycle', 'restore'].includes(action)) {
    throw new Error('Unsupported Instore action');
  }
  return request('/api/instore-admin', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ action, sku, version }),
  }, `Could not ${action} Instore product`);
}

export const instoreAdminApi = {
  fetch: fetchInstoreProducts,
  stage: stageInstoreFile,
  update: updateInstoreProduct,
  mutate: mutateInstoreProduct,
};

export default instoreAdminApi;

