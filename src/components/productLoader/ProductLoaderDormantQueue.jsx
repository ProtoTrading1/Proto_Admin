import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Eye, Loader2, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { classifyDormantRow, DORMANT_SECTION_LABELS } from '../../lib/parseIntakeFilename';

function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

function childrenOf(tree, id) {
  return findNode(tree, id)?.children || [];
}

export default function ProductLoaderDormantQueue({
  taxonomyTree,
  rows,
  edits,
  setEdits,
  loading,
  saving,
  error = '',
  loaded = false,
  onRefresh,
  onRetry,
  onSaveCategories,
  onRemove,
  onOpen,
  imageIntakeText,
  setImageIntakeText,
  imageIntakeItems = [],
  imageIntakeLoading = false,
  imageIntakeError = '',
  onLookupImageIntake,
  onQueueImageIntake,
  imageJobs = [],
  imageJobsLoading = false,
  imageJobsError = '',
  imageProcessingHealth = null,
  selectedImageJobId = '',
  onSelectImageJob,
  imageJobBusy = '',
  onProcessImageJob,
  onUploadManualCandidate,
  onApproveImageJob,
  onApplyImageJob,
  onDiscardImageJob,
}) {
  const selectedJob = imageJobs.find((job) => job.id === selectedImageJobId) || null;
  const [reviewChecklist, setReviewChecklist] = useState({
    correctProduct: false,
    labelsPreserved: false,
    backgroundClean: false,
  });
  const [reviewNotes, setReviewNotes] = useState('');
  const [confirmSku, setConfirmSku] = useState('');

  useEffect(() => {
    setReviewChecklist({ correctProduct: false, labelsPreserved: false, backgroundClean: false });
    setReviewNotes('');
    setConfirmSku('');
  }, [selectedImageJobId]);

  const checklistComplete = Object.values(reviewChecklist).every(Boolean);
  const sections = {
    waitingImages: [],
    waitingCategories: [],
    waitingApproval: [],
    readyToPublish: [],
  };

  for (const row of rows) {
    const key = classifyDormantRow(row);
    sections[key].push(row);
  }

  const renderSection = (key) => {
    const list = sections[key];
    if (!list.length) return null;
    return (
      <section key={key} className="pl-dormant-section">
        <h4>
          {DORMANT_SECTION_LABELS[key]} <span className="adm-muted">({list.length})</span>
        </h4>
        <div className="pl-dormant-list">
          {list.map((row) => {
            const edit = edits[row.sku] || { categoryId: '', sub1Id: '', sub2Id: '', sub3Id: '', sub4Id: '' };
            const sub1Options = edit.categoryId ? childrenOf(taxonomyTree, edit.categoryId) : [];
            const busy = saving === `rm-${row.sku}` || saving === `cat-${row.sku}` || saving === `pub-${row.sku}`;

            return (
              <article key={row.sku} className="pl-dormant-card">
                <div className="pl-dormant-card-head">
                  <div>
                    <strong>{row.title}</strong>
                    <span className="adm-muted">{row.sku}</span>
                  </div>
                  <span className="adm-muted">R{Number(row.price || 0).toFixed(2)}</span>
                </div>
                <div className="pl-dormant-card-fields">
                  <select
                    className="adm-select adm-select--enhanced"
                    value={edit.categoryId}
                    onChange={(e) => setEdits((prev) => ({
                      ...prev,
                      [row.sku]: { ...edit, categoryId: e.target.value, sub1Id: '' },
                    }))}
                  >
                    <option value="">Category</option>
                    {taxonomyTree.map((cat) => <option key={cat.id} value={cat.id}>{cat.label}</option>)}
                  </select>
                  {sub1Options.length > 0 && (
                    <select
                      className="adm-select adm-select--enhanced"
                      value={edit.sub1Id}
                      onChange={(e) => setEdits((prev) => ({
                        ...prev,
                        [row.sku]: { ...edit, sub1Id: e.target.value },
                      }))}
                    >
                      <option value="">Subcategory</option>
                      {sub1Options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
                    </select>
                  )}
                </div>
                <div className="pl-action-row">
                  <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={busy} onClick={() => onOpen?.(row)}>
                    Open
                  </button>
                  <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={busy} onClick={() => onSaveCategories?.(row.sku)}>
                    Save categories
                  </button>
                  <button type="button" className="adm-btn-ghost adm-btn--sm" style={{ color: '#dc2626' }} disabled={busy} onClick={() => onRemove?.(row.sku)}>
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="pl-section">
      <div className="pl-section-head-row">
        <p className="pl-section-note">Every candidate stays staged until an owner completes the review and explicitly applies it. Processing never replaces a website image automatically.</p>
        <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          Refresh queue
        </button>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={onRetry} disabled={loading}>
            Retry queue load
          </button>
        </div>
      )}

      {loading && !rows.length && <p className="adm-muted"><Loader2 size={14} className="spin" /> Loading queue...</p>}
      {!loading && !rows.length && loaded && !error && <p className="adm-muted">No products are waiting in Image Processing Centre.</p>}

      <section className="pl-dormant-section" style={{ marginTop: 18 }}>
        <h4>Nutstore image intake</h4>
        <p className="adm-muted">Paste one Nutstore image path per line. Only an exact existing SKU and image slot can be queued.</p>
        <textarea className="adm-input" rows={3} value={imageIntakeText} onChange={(event) => setImageIntakeText?.(event.target.value)} placeholder="/PTR Photos/Folder/SKU.1.jpg" style={{ width: '100%', resize: 'vertical', margin: '8px 0' }} />
        <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={onLookupImageIntake} disabled={imageIntakeLoading}>
          {imageIntakeLoading ? <Loader2 size={13} className="spin" /> : <Eye size={13} />} Check exact matches
        </button>
        {imageIntakeError && <p style={{ color: '#b91c1c', marginTop: 8 }}>{imageIntakeError}</p>}
        {!!imageIntakeItems.length && <div className="pl-dormant-list" style={{ marginTop: 10 }}>
          {imageIntakeItems.map((item) => (
            <article key={item.path} className="pl-dormant-card">
              <strong>{item.filename}</strong>
              <span className="adm-muted">{item.code || 'No exact SKU'} · slot {item.imageSlot || 1}</span>
              {item.canQueue ? <p style={{ color: '#15803d', margin: '6px 0' }}>Exact product match — ready to queue.</p> : <p style={{ color: '#b45309', margin: '6px 0' }}>{item.queueBlocker || 'This file cannot enter the queue.'}</p>}
              <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={!item.canQueue} onClick={() => onQueueImageIntake?.(item)}>Queue for review</button>
            </article>
          ))}
        </div>}
      </section>

      <section className="pl-dormant-section" style={{ marginTop: 18 }}>
        <h4>Processing queue <span className="adm-muted">({imageJobs.length})</span></h4>
        <p className="adm-muted">Queued → Processing or manual candidate → Ready for review → Approved → Explicit apply. Review history is saved on the server.</p>
        {imageProcessingHealth && !imageProcessingHealth.processorConfigured && (
          <p style={{ color: '#b45309' }}>AI processing is not configured. Manual candidates can still be reviewed, but standard cleanup is unavailable.</p>
        )}
        {imageJobsError && <p style={{ color: '#b91c1c' }}>{imageJobsError}</p>}
        {imageJobsLoading && !imageJobs.length && <p className="adm-muted"><Loader2 size={14} className="spin" /> Loading saved image jobs...</p>}
        {!imageJobsLoading && !imageJobs.length && !imageJobsError && <p className="adm-muted">No image jobs are queued yet.</p>}
        {!!imageJobs.length && <div className="pl-dormant-list">
          {imageJobs.map((job) => {
            const labels = {
              queued: 'Queued',
              processing: 'Processing',
              ready_for_review: 'Ready for review',
              needs_attention: 'Needs attention',
              approved: 'Approved — waiting for explicit apply',
              applying: 'Applying approved image',
              applied: 'Applied',
              discarded: 'Discarded',
              expired: 'Expired',
            };
            const colour = job.status === 'needs_attention' ? '#b45309'
              : job.status === 'approved' || job.status === 'applied' ? '#15803d'
                : '#475569';
            return <button key={job.id} type="button" className="pl-dormant-card" style={{ textAlign: 'left', borderColor: selectedImageJobId === job.id ? '#8B1A1A' : undefined }} onClick={() => onSelectImageJob?.(job.id)}>
              <strong>{job.product_title || job.sku}</strong><span className="adm-muted">{job.sku} · slot {job.targetSlot} · {job.treatmentLabel}</span>
              <span style={{ display: 'block', marginTop: 6, fontWeight: 700, color: colour }}>{labels[job.status] || job.status}</span>
            </button>;
          })}
        </div>}
        {selectedJob && <div className="pl-preview-card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <strong>{selectedJob.sku} · image slot {selectedJob.targetSlot}</strong>
            <span className="adm-muted">Original retained · {selectedJob.history.length} history event{selectedJob.history.length === 1 ? '' : 's'}</span>
          </div>
          <p className="adm-muted" style={{ marginTop: 6 }}><strong>{selectedJob.treatmentLabel}</strong> — {selectedJob.treatmentReason}</p>
          <div className="pl-preview-card-body" style={{ marginTop: 12 }}>
            <div><small className="adm-muted">Original source</small><div className="pl-preview-thumb">{selectedJob.originalUrl ? <img src={selectedJob.originalUrl} alt={`Original ${selectedJob.sku}`} /> : <span className="adm-muted">Original unavailable</span>}</div></div>
            <div><small className="adm-muted">Review candidate</small><div className="pl-preview-thumb">{selectedJob.processedUrl ? <img src={selectedJob.processedUrl} alt={`Review candidate ${selectedJob.sku}`} /> : <span className="adm-muted">No candidate yet</span>}</div></div>
          </div>
          {selectedJob.error && <p style={{ color: '#b91c1c' }}>{selectedJob.error}</p>}

          {selectedJob.manualOnly && ['queued', 'needs_attention'].includes(selectedJob.status) && (
            <div style={{ marginTop: 12, padding: 10, border: '1px solid #fcd34d', borderRadius: 8, background: '#fffbeb' }}>
              <p style={{ margin: '0 0 8px', color: '#92400e' }}><strong>Manual lane.</strong> AI cleanup is disabled for transparent packaging and fine-detail/bead products. Prepare the image manually, then upload that candidate for the same review and apply safeguards.</p>
              <input type="file" accept="image/*" disabled={Boolean(imageJobBusy)} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUploadManualCandidate?.(file);
                event.target.value = '';
              }} />
            </div>
          )}

          {!selectedJob.manualOnly && ['queued', 'needs_attention'].includes(selectedJob.status) && (
            <div className="pl-action-row" style={{ marginTop: 12 }}>
              <button type="button" className="adm-btn-red adm-btn--sm" disabled={Boolean(imageJobBusy)} onClick={onProcessImageJob}>
                {imageJobBusy === 'process' ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />} Process staged candidate
              </button>
              <label className="adm-btn-ghost adm-btn--sm" style={{ cursor: imageJobBusy ? 'not-allowed' : 'pointer' }}>
                <Upload size={12} /> Upload manual candidate
                <input type="file" accept="image/*" disabled={Boolean(imageJobBusy)} style={{ display: 'none' }} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadManualCandidate?.(file);
                  event.target.value = '';
                }} />
              </label>
            </div>
          )}

          {selectedJob.status === 'ready_for_review' && selectedJob.processedUrl && (
            <div style={{ marginTop: 12 }}>
              <p style={{ marginBottom: 6, fontWeight: 700 }}>Required review confirmation</p>
              {[
                ['correctProduct', 'This is the correct product and SKU.'],
                ['labelsPreserved', 'Labels, logos, barcodes and markings are preserved.'],
                ['backgroundClean', 'The background and edges are clean without changing the product.'],
              ].map(([key, label]) => (
                <label key={key} style={{ display: 'block', margin: '5px 0', fontSize: 13 }}>
                  <input type="checkbox" checked={reviewChecklist[key]} onChange={(event) => setReviewChecklist((current) => ({ ...current, [key]: event.target.checked }))} /> {label}
                </label>
              ))}
              <textarea className="adm-input" rows={2} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Optional review note" style={{ width: '100%', resize: 'vertical', marginTop: 8 }} />
              <button type="button" className="adm-btn-ghost adm-btn--sm" style={{ marginTop: 8 }} disabled={Boolean(imageJobBusy) || !checklistComplete} onClick={() => onApproveImageJob?.({ reviewChecklist, reviewNotes })}>
                {imageJobBusy === 'approve' ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />} Record approval
              </button>
            </div>
          )}

          {selectedJob.status === 'approved' && (
            <div style={{ marginTop: 12, padding: 10, border: '1px solid #bbf7d0', borderRadius: 8, background: '#f0fdf4' }}>
              {imageProcessingHealth?.environment === 'production' ? <>
                <p style={{ margin: '0 0 8px', color: '#166534' }}>Approval is recorded. To make the one intentional live change, type <strong>{selectedJob.sku}</strong> exactly.</p>
                <input className="adm-input" value={confirmSku} onChange={(event) => setConfirmSku(event.target.value)} placeholder={`Type ${selectedJob.sku} to apply`} style={{ width: '100%', marginBottom: 8 }} />
                <button type="button" className="adm-btn-red adm-btn--sm" disabled={Boolean(imageJobBusy) || confirmSku.trim().toUpperCase() !== selectedJob.sku} onClick={() => onApplyImageJob?.(confirmSku)}>
                  {imageJobBusy === 'apply' ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />} Apply approved image
                </button>
              </> : <p className="adm-muted" style={{ margin: 0 }}>Applying is disabled in preview. This lets you test the saved review workflow without changing a live catalogue image.</p>}
            </div>
          )}

          {['queued', 'needs_attention', 'ready_for_review', 'approved'].includes(selectedJob.status) && (
            <button type="button" className="adm-btn-ghost adm-btn--sm" style={{ marginTop: 12, color: '#b91c1c' }} disabled={Boolean(imageJobBusy)} onClick={onDiscardImageJob}>
              <Trash2 size={12} /> Discard staged job
            </button>
          )}
          <details style={{ marginTop: 10 }}><summary><Clock3 size={13} /> Processing history</summary><ul>{selectedJob.history.map((event, index) => <li key={`${event.at}-${index}`}>{new Date(event.at).toLocaleString()} — {event.label}</li>)}</ul></details>
        </div>}
      </section>

      {renderSection('waitingImages')}
      {renderSection('waitingCategories')}
      {renderSection('waitingApproval')}
      {renderSection('readyToPublish')}
    </div>
  );
}
