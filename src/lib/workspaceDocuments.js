import { supabase } from './supabase';
import { readApiJson } from './apiError';
import {
  normalizeDocumentTags,
  validateDocumentFile,
} from '../../lib/workspace-documents.mjs';
import { hashDocumentFile, ingestDocumentFile } from './documentIngestion';

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return readApiJson(res, { fallback: 'Workspace document request failed' });
}

export async function listWorkspaceDocuments({ workspaceType, recordId = '', archived = false }) {
  const params = new URLSearchParams({ workspaceType });
  if (recordId) params.set('recordId', recordId);
  if (archived) params.set('archived', '1');
  const json = await request(`/api/workspace-documents?${params}`);
  return json.documents || [];
}

export async function getWorkspaceDocumentUrl(id, { download = false } = {}) {
  const params = new URLSearchParams({ action: 'url', id });
  if (download) params.set('download', '1');
  return request(`/api/workspace-documents?${params}`);
}

export async function updateWorkspaceDocument(id, fields) {
  const json = await request('/api/workspace-documents', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'update', ...fields }),
  });
  return json.document;
}

export async function archiveWorkspaceDocument(id) {
  const json = await request('/api/workspace-documents', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'archive' }),
  });
  return json.document;
}

export async function restoreWorkspaceDocument(id) {
  const json = await request('/api/workspace-documents', {
    method: 'PATCH',
    body: JSON.stringify({ id, action: 'restore' }),
  });
  return json.document;
}

export async function uploadWorkspaceDocument({
  workspaceType,
  recordId = '',
  file,
  category = 'general',
  tags = [],
  notes = '',
  title = '',
  onIngestionProgress,
}) {
  const validation = validateDocumentFile(file);
  if (!validation.ok) throw new Error(`${file.name}: ${validation.error}`);

  onIngestionProgress?.({ phase: 'hashing', progress: 0.02, detail: 'Checking for duplicates' });
  const contentHash = await hashDocumentFile(file);
  const ingestionPromise = ingestDocumentFile(file, {
    selectedCategory: category,
    contentHash,
    onProgress: onIngestionProgress,
  });
  const prepared = await request('/api/workspace-documents', {
    method: 'POST',
    body: JSON.stringify({
      action: 'prepare',
      workspaceType,
      recordId,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      byteSize: file.size,
      category,
      tags: normalizeDocumentTags(tags),
      notes,
      title,
      contentHash,
    }),
  });

  onIngestionProgress?.({ phase: 'uploading', progress: 0.1, detail: 'Securing original file' });
  const uploadPromise = supabase.storage
    .from(prepared.bucket)
    .uploadToSignedUrl(prepared.upload.path, prepared.upload.token, file, {
      contentType: file.type || 'application/octet-stream',
      cacheControl: '3600',
    });
  const [{ error }, ingestion] = await Promise.all([uploadPromise, ingestionPromise]);
  if (error) throw error;

  const completed = await request('/api/workspace-documents', {
    method: 'POST',
    body: JSON.stringify({
      action: 'complete',
      id: prepared.document.id,
      extractedText: ingestion.extractedText,
      extractionStatus: ingestion.extractionStatus,
      category: ingestion.category,
      tags: ingestion.tags,
      summary: ingestion.summary,
      suggestedWorkspace: ingestion.suggestedWorkspace,
      classificationConfidence: ingestion.classificationConfidence,
      detectedEntities: ingestion.detectedEntities,
      contentHash: ingestion.contentHash,
    }),
  });
  onIngestionProgress?.({ phase: 'complete', progress: 1, detail: 'Document indexed' });
  return completed.document;
}

export async function uploadWorkspaceDocuments(options) {
  const files = Array.from(options.files || []);
  const uploaded = [];
  for (let index = 0; index < files.length; index += 1) {
    options.onProgress?.({ index, total: files.length, file: files[index] });
    uploaded.push(await uploadWorkspaceDocument({
      ...options,
      file: files[index],
      onIngestionProgress: (progress) => options.onIngestionProgress?.({ ...progress, index, total: files.length, file: files[index] }),
    }));
  }
  options.onProgress?.({ index: files.length, total: files.length, file: null });
  return uploaded;
}
