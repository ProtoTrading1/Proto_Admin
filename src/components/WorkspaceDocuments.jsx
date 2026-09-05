import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BrainCircuit,
  Download,
  Eye,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  RotateCcw,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_CATEGORIES,
  defaultDocumentCategory,
  documentExtension,
  formatDocumentBytes,
  normalizeDocumentTags,
} from '../../lib/workspace-documents.mjs';
import {
  archiveWorkspaceDocument,
  getWorkspaceDocumentUrl,
  listWorkspaceDocuments,
  restoreWorkspaceDocument,
  uploadWorkspaceDocuments,
} from '../lib/workspaceDocuments';

const CATEGORY_LABELS = {
  general: 'General', quote: 'Quote', invoice: 'Invoice', payment: 'Payment',
  contract: 'Contract', shipping: 'Shipping', product: 'Product', image: 'Image',
  correspondence: 'Correspondence', spreadsheet: 'Spreadsheet', other: 'Other',
};

function fileIcon(document) {
  const extension = documentExtension(document.filename);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'].includes(extension)) return FileImage;
  if (['xls', 'xlsx', 'csv'].includes(extension)) return FileSpreadsheet;
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'eml'].includes(extension)) return FileText;
  return File;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function canInlinePreview(document) {
  return document.content_type?.startsWith('image/') || document.content_type === 'application/pdf';
}

export default function WorkspaceDocuments({
  workspaceType,
  recordId = '',
  scopeLabel = '',
  onShowToast,
  compact = false,
}) {
  const inputRef = useRef(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [uploading, setUploading] = useState(null);
  const [ingestion, setIngestion] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  const toast = useCallback((message, type = 'success') => {
    if (onShowToast) onShowToast(message, type);
  }, [onShowToast]);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setDocuments(await listWorkspaceDocuments({ workspaceType, recordId, archived }));
    } catch (requestError) {
      setError(requestError.message || 'Could not load documents');
    } finally {
      setLoading(false);
    }
  }, [workspaceType, recordId, archived]);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  const visibleDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return documents;
    return documents.filter((document) => [
      document.title,
      document.filename,
      document.category,
      document.notes,
      ...(document.tags || []),
    ].filter(Boolean).join(' ').toLowerCase().includes(term));
  }, [documents, search]);

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || uploading) return;
    setError('');
    try {
      await uploadWorkspaceDocuments({
        workspaceType,
        recordId,
        files,
        category: category === 'general' && files.length === 1 ? defaultDocumentCategory(files[0].name) : category,
        tags: normalizeDocumentTags(tags),
        onProgress: ({ index, total, file }) => setUploading(file ? { index: index + 1, total, name: file.name } : null),
        onIngestionProgress: (progress) => setIngestion(progress),
      });
      setTags('');
      await loadDocuments();
      toast(`${files.length} document${files.length === 1 ? '' : 's'} secured in ${scopeLabel || workspaceType}`);
    } catch (uploadError) {
      setError(uploadError.message || 'Upload failed');
      toast(uploadError.message || 'Upload failed', 'error');
    } finally {
      setUploading(null);
      setIngestion(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const openDocument = async (document, download = false) => {
    try {
      const signed = await getWorkspaceDocumentUrl(document.id, { download });
      if (!download && canInlinePreview(document)) {
        setPreview({ document, url: signed.url });
      } else {
        window.open(signed.url, '_blank', 'noopener,noreferrer');
      }
    } catch (requestError) {
      toast(requestError.message || 'Could not open document', 'error');
    }
  };

  const changeArchiveState = async (document) => {
    try {
      if (archived) await restoreWorkspaceDocument(document.id);
      else await archiveWorkspaceDocument(document.id);
      await loadDocuments();
      toast(archived ? 'Document restored' : 'Document archived');
    } catch (requestError) {
      toast(requestError.message || 'Could not update document', 'error');
    }
  };

  return (
    <section className={`workspace-documents${compact ? ' workspace-documents--compact' : ''}`}>
      <header className="workspace-documents-head">
        <div>
          <span className="workspace-documents-kicker"><ShieldCheck size={13} /> Private document vault</span>
          <h3>Documents</h3>
          <p>{scopeLabel ? `Evidence and knowledge for ${scopeLabel}.` : 'Evidence and knowledge linked to this workspace.'}</p>
        </div>
        <div className="workspace-documents-view-toggle" aria-label="Document view">
          <button type="button" className={!archived ? 'is-active' : ''} onClick={() => setArchived(false)}>Current</button>
          <button type="button" className={archived ? 'is-active' : ''} onClick={() => setArchived(true)}>Archived</button>
        </div>
      </header>

      {!archived && (
        <div
          className={`workspace-document-drop${dragging ? ' is-dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}
        >
          <input ref={inputRef} type="file" accept={DOCUMENT_ACCEPT} multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
          <span className="workspace-document-drop-icon"><UploadCloud size={22} /></span>
          <div>
            <strong>{uploading ? `Processing ${uploading.index} of ${uploading.total}` : 'Drop business documents or images here'}</strong>
            <small>{ingestion?.detail || uploading?.name || 'Each file is stored privately with the order · 25 MB each'}</small>
            {uploading && <span className="workspace-document-progress"><i style={{ width: `${Math.round(Number(ingestion?.progress || 0.08) * 100)}%` }} /></span>}
          </div>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(uploading)}>
            {uploading ? <Loader2 size={15} className="spin" /> : <UploadCloud size={15} />}
            {uploading ? 'Securing…' : 'Choose files'}
          </button>
        </div>
      )}

      {!archived && (
        <div className="workspace-document-controls">
          <label>
            <span>Document type</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {DOCUMENT_CATEGORIES.map((value) => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="workspace-document-tags">
            <span>Tags</span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="supplier, urgent, winter-range" />
          </label>
        </div>
      )}

      <label className="workspace-document-search">
        <Search size={15} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents, tags or notes" />
      </label>

      {error && <div className="workspace-document-error">{error}</div>}
      {loading ? (
        <div className="workspace-document-state"><Loader2 size={18} className="spin" /> Loading documents…</div>
      ) : visibleDocuments.length ? (
        <div className="workspace-document-list">
          {visibleDocuments.map((document) => {
            const Icon = fileIcon(document);
            return (
              <article key={document.id} className="workspace-document-row">
                <span className="workspace-document-file-icon"><Icon size={19} /></span>
                <div className="workspace-document-file-copy">
                  <div>
                    <strong>{document.title || document.filename}</strong>
                    {document.version > 1 && <span className="workspace-document-version">v{document.version}</span>}
                  </div>
                  <p>{CATEGORY_LABELS[document.category] || document.category} · {formatDocumentBytes(document.byte_size)} · {formatDate(document.uploaded_at || document.created_at)}</p>
                  {document.summary && <small className="workspace-document-summary">{document.summary}</small>}
                  <div className="workspace-document-chips">
                    {(document.tags || []).map((tag) => <span key={tag}>{tag}</span>)}
                    {document.extraction_status === 'ready' && <span className="is-searchable"><BrainCircuit size={9} />Indexed</span>}
                    {document.suggested_workspace && document.suggested_workspace !== document.workspace_type && (
                      <span className="is-suggestion">Suggested: {document.suggested_workspace}</span>
                    )}
                    {Object.values(document.detected_entities || {}).flat().length > 0 && (
                      <span>{Object.values(document.detected_entities).flat().length} references detected</span>
                    )}
                  </div>
                </div>
                <div className="workspace-document-actions">
                  <button type="button" title="Preview" onClick={() => void openDocument(document, false)}><Eye size={15} /></button>
                  <button type="button" title="Download" onClick={() => void openDocument(document, true)}><Download size={15} /></button>
                  <button type="button" title={archived ? 'Restore' : 'Archive'} onClick={() => void changeArchiveState(document)}>
                    {archived ? <RotateCcw size={15} /> : <Archive size={15} />}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="workspace-document-state">
          <FileText size={20} />
          <strong>{search ? 'No matching documents' : archived ? 'No archived documents' : 'No documents yet'}</strong>
          <span>{search ? 'Try a different search.' : archived ? 'Archived documents remain recoverable here.' : 'Upload the first piece of operational evidence.'}</span>
        </div>
      )}

      {preview && (
        <div className="workspace-document-preview" role="dialog" aria-modal="true" aria-label={`Preview ${preview.document.filename}`}>
          <div className="workspace-document-preview-card">
            <header>
              <div><strong>{preview.document.filename}</strong><span>Private preview · link expires automatically</span></div>
              <button type="button" onClick={() => setPreview(null)} aria-label="Close preview"><X size={18} /></button>
            </header>
            {preview.document.content_type?.startsWith('image/')
              ? <img src={preview.url} alt={preview.document.title || preview.document.filename} />
              : <iframe src={preview.url} title={preview.document.filename} />}
          </div>
        </div>
      )}
    </section>
  );
}
