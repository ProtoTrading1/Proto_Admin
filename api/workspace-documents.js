import { randomUUID } from 'node:crypto';
import { requireAdminKey, verifyAdminUser } from './_admin-auth.js';
import { getPortalAdminClient } from './_site-config.js';
import {
  ensureWorkspaceDocumentBucket,
  loadWorkspaceDocumentIndex,
  mutateWorkspaceDocumentIndex,
  WORKSPACE_DOCUMENT_BUCKET,
} from './_workspace-document-store.js';
import {
  DOCUMENT_CATEGORIES,
  MAX_EXTRACTED_TEXT,
  WORKSPACE_TYPES,
  documentVersionGroup,
  normalizeDocumentTags,
  safeDocumentFilename,
  validateDocumentFile,
} from '../lib/workspace-documents.mjs';

function cleanScope(value) {
  return String(value || '').trim().slice(0, 180);
}

function publicDocument(document) {
  if (!document) return null;
  const { extracted_text: _text, content_hash: _hash, storage_bucket: _bucket, storage_path: _path, ...safe } = document;
  return safe;
}

function actorFallback(req) {
  return String(req.headers['x-admin-email'] || req.body?.actor || 'admin').trim().toLowerCase() || 'admin';
}

async function requestActor(req) {
  const user = await verifyAdminUser(req);
  return user?.email?.toLowerCase() || actorFallback(req);
}

function validateScope(workspaceType, category = 'general') {
  if (!WORKSPACE_TYPES.includes(workspaceType)) throw new Error('Unknown workspace type');
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new Error('Unknown document category');
}

async function prepareUpload(req, res, supabase, actor) {
  const {
    workspaceType = '', recordId = '', filename = '', contentType = 'application/octet-stream',
    byteSize = 0, category = 'general', tags = [], notes = '', title = '',
    contentHash = '',
  } = req.body || {};
  validateScope(workspaceType, category);
  const validation = validateDocumentFile({ name: filename, size: byteSize });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  await ensureWorkspaceDocumentBucket(supabase);
  const safeName = safeDocumentFilename(filename);
  const versionGroup = documentVersionGroup(filename);
  const scopeId = cleanScope(recordId) || null;
  const normalizedHash = /^[a-f0-9]{64}$/i.test(String(contentHash || '')) ? String(contentHash).toLowerCase() : '';
  const id = randomUUID();
  const storagePath = `${workspaceType}/${scopeId || '_library'}/${id}/${safeName}`;

  const document = await mutateWorkspaceDocumentIndex(supabase, (documents) => {
    const duplicate = normalizedHash && documents.find((row) => row.content_hash === normalizedHash
      && row.workspace_type === workspaceType
      && (row.record_id || null) === scopeId
      && row.upload_status !== 'failed'
      && !row.deleted_at);
    if (duplicate) {
      const error = new Error(`Duplicate document: ${duplicate.filename} is already in this workspace.`);
      error.statusCode = 409;
      throw error;
    }
    const previous = documents
      .filter((row) => row.workspace_type === workspaceType
        && (row.record_id || null) === scopeId
        && row.version_group === versionGroup)
      .sort((a, b) => b.version - a.version)[0] || null;
    const created = {
      id,
      workspace_type: workspaceType,
      record_id: scopeId,
      title: String(title || '').trim().slice(0, 180),
      filename: safeName,
      extension: validation.extension,
      content_type: String(contentType || 'application/octet-stream').slice(0, 180),
      byte_size: Number(byteSize),
      category,
      tags: normalizeDocumentTags(tags),
      notes: String(notes || '').trim().slice(0, 2000),
      storage_bucket: WORKSPACE_DOCUMENT_BUCKET,
      storage_path: storagePath,
      version_group: versionGroup,
      version: (previous?.version || 0) + 1,
      supersedes_id: previous?.id || null,
      content_hash: normalizedHash,
      upload_status: 'uploading',
      extraction_status: 'processing',
      extracted_text: '',
      summary: '',
      suggested_workspace: null,
      classification_confidence: null,
      detected_entities: { emails: [], references: [], skus: [] },
      ingested_at: null,
      uploaded_by: actor,
      created_at: new Date().toISOString(),
      uploaded_at: null,
      deleted_at: null,
      deleted_by: null,
    };
    documents.push(created);
    return created;
  });

  const { data: signed, error: signError } = await supabase.storage
    .from(WORKSPACE_DOCUMENT_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (signError) {
    await mutateWorkspaceDocumentIndex(supabase, (documents) => {
      const failed = documents.find((row) => row.id === id);
      if (failed) failed.upload_status = 'failed';
    });
    throw signError;
  }
  return res.status(201).json({ document: publicDocument(document), upload: signed, bucket: WORKSPACE_DOCUMENT_BUCKET });
}

async function completeUpload(req, res, supabase) {
  const id = cleanScope(req.body?.id);
  if (!id) return res.status(400).json({ error: 'Document id required' });
  const documents = await loadWorkspaceDocumentIndex(supabase);
  const pending = documents.find((row) => row.id === id);
  if (!pending) return res.status(404).json({ error: 'Document upload not found' });

  const slash = pending.storage_path.lastIndexOf('/');
  const folder = pending.storage_path.slice(0, slash);
  const name = pending.storage_path.slice(slash + 1);
  const { data: objects, error: listError } = await supabase.storage
    .from(pending.storage_bucket)
    .list(folder, { search: name, limit: 10 });
  if (listError) throw listError;
  if (!(objects || []).some((object) => object.name === name)) {
    return res.status(409).json({ error: 'The file did not reach private storage. Please retry the upload.' });
  }

  const extractedText = String(req.body?.extractedText || '').slice(0, MAX_EXTRACTED_TEXT);
  const requestedExtractionStatus = ['ready', 'unsupported', 'failed'].includes(req.body?.extractionStatus)
    ? req.body.extractionStatus
    : (extractedText ? 'ready' : 'unsupported');
  const requestedCategory = DOCUMENT_CATEGORIES.includes(req.body?.category) ? req.body.category : pending.category;
  const suggestedWorkspace = WORKSPACE_TYPES.includes(req.body?.suggestedWorkspace) ? req.body.suggestedWorkspace : null;
  const confidence = Number(req.body?.classificationConfidence);
  const rawEntities = req.body?.detectedEntities || {};
  const detectedEntities = {
    emails: Array.isArray(rawEntities.emails) ? rawEntities.emails.map(String).slice(0, 12) : [],
    references: Array.isArray(rawEntities.references) ? rawEntities.references.map(String).slice(0, 20) : [],
    skus: Array.isArray(rawEntities.skus) ? rawEntities.skus.map(String).slice(0, 30) : [],
  };
  const document = await mutateWorkspaceDocumentIndex(supabase, (index) => {
    const row = index.find((item) => item.id === id);
    if (!row) throw new Error('Document upload not found');
    row.upload_status = 'available';
    row.uploaded_at = new Date().toISOString();
    row.extracted_text = extractedText;
    row.extraction_status = requestedExtractionStatus;
    row.category = requestedCategory;
    row.tags = normalizeDocumentTags([...(row.tags || []), ...(Array.isArray(req.body?.tags) ? req.body.tags : [])]);
    row.summary = String(req.body?.summary || '').trim().slice(0, 500);
    row.suggested_workspace = suggestedWorkspace;
    row.classification_confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null;
    row.detected_entities = detectedEntities;
    row.content_hash = /^[a-f0-9]{64}$/i.test(String(req.body?.contentHash || '')) ? String(req.body.contentHash).toLowerCase() : row.content_hash;
    row.ingested_at = new Date().toISOString();
    return row;
  });
  return res.status(200).json({ document: publicDocument(document) });
}

async function signedDocumentUrl(req, res, supabase) {
  const id = cleanScope(req.query?.id);
  if (!id) return res.status(400).json({ error: 'Document id required' });
  const document = (await loadWorkspaceDocumentIndex(supabase)).find((row) => row.id === id);
  if (!document || document.deleted_at || document.upload_status !== 'available') {
    return res.status(404).json({ error: 'Document not found' });
  }
  const { data, error } = await supabase.storage
    .from(document.storage_bucket)
    .createSignedUrl(document.storage_path, 600, { download: req.query?.download === '1' ? document.filename : false });
  if (error) throw error;
  return res.status(200).json({ url: data.signedUrl, filename: document.filename, contentType: document.content_type, expiresIn: 600 });
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  const supabase = getPortalAdminClient();
  try {
    if (req.method === 'GET' && req.query?.action === 'url') return await signedDocumentUrl(req, res, supabase);

    if (req.method === 'GET') {
      const workspaceType = cleanScope(req.query?.workspaceType);
      const recordId = cleanScope(req.query?.recordId) || null;
      const archived = req.query?.archived === '1';
      validateScope(workspaceType);
      const documents = (await loadWorkspaceDocumentIndex(supabase))
        .filter((row) => row.workspace_type === workspaceType
          && (row.record_id || null) === recordId
          && row.upload_status === 'available'
          && (archived ? Boolean(row.deleted_at) : !row.deleted_at))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 200)
        .map(publicDocument);
      return res.status(200).json({ documents });
    }

    const actor = await requestActor(req);
    if (req.method === 'POST' && req.body?.action === 'prepare') return await prepareUpload(req, res, supabase, actor);
    if (req.method === 'POST' && req.body?.action === 'complete') return await completeUpload(req, res, supabase);

    if (req.method === 'PATCH') {
      const id = cleanScope(req.body?.id);
      if (!id) return res.status(400).json({ error: 'Document id required' });
      const action = req.body?.action || 'update';
      const document = await mutateWorkspaceDocumentIndex(supabase, (documents) => {
        const row = documents.find((item) => item.id === id);
        if (!row) throw new Error('Document not found');
        if (action === 'restore') {
          row.deleted_at = null;
          row.deleted_by = null;
        } else if (action === 'archive') {
          row.deleted_at = new Date().toISOString();
          row.deleted_by = actor;
        } else {
          if (req.body?.title !== undefined) row.title = String(req.body.title || '').trim().slice(0, 180);
          if (req.body?.notes !== undefined) row.notes = String(req.body.notes || '').trim().slice(0, 2000);
          if (req.body?.tags !== undefined) row.tags = normalizeDocumentTags(req.body.tags);
          if (req.body?.category !== undefined) {
            if (!DOCUMENT_CATEGORIES.includes(req.body.category)) throw new Error('Unknown document category');
            row.category = req.body.category;
          }
        }
        return row;
      });
      return res.status(200).json({ document: publicDocument(document) });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    const status = error?.statusCode || (/Unknown|Unsupported|must be|empty|required|not found|Duplicate/i.test(error?.message || '') ? 400 : 500);
    return res.status(status).json({ error: error?.message || 'Document request failed' });
  }
}
