// New uploads land here. Older document rows carry their own storage_bucket
// (the retired 'apollo-documents' name), so reads of existing rows still work.
export const WORKSPACE_DOCUMENT_BUCKET = 'workspace-documents';
const INDEX_PATH = '_system/document-index.json';
let mutationQueue = Promise.resolve();

export async function ensureWorkspaceDocumentBucket(supabase) {
  const { error } = await supabase.storage.createBucket(WORKSPACE_DOCUMENT_BUCKET, {
    public: false,
    fileSizeLimit: 25 * 1024 * 1024,
    allowedMimeTypes: [
      'application/octet-stream',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv', 'text/rtf', 'message/rfc822',
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic',
    ],
  });
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
}

export async function loadWorkspaceDocumentIndex(supabase) {
  await ensureWorkspaceDocumentBucket(supabase);
  const { data, error } = await supabase.storage
    .from(WORKSPACE_DOCUMENT_BUCKET)
    .download(INDEX_PATH);
  if (error) {
    if (/not found|does not exist|404/i.test(error.message || '')) return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(await data.text());
    return Array.isArray(parsed?.documents) ? parsed.documents : [];
  } catch {
    throw new Error('Workspace document index is invalid');
  }
}

async function saveWorkspaceDocumentIndex(supabase, documents) {
  const payload = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    documents,
  });
  const { error } = await supabase.storage
    .from(WORKSPACE_DOCUMENT_BUCKET)
    .upload(INDEX_PATH, payload, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: true,
    });
  if (error) throw error;
}

export function mutateWorkspaceDocumentIndex(supabase, mutator) {
  const operation = mutationQueue.then(async () => {
    const documents = await loadWorkspaceDocumentIndex(supabase);
    const result = await mutator(documents);
    await saveWorkspaceDocumentIndex(supabase, documents);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}
