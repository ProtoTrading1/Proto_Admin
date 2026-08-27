import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Check,
  CheckCircle,
  Clock3,
  FolderOpen,
  ImageOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  createNutstoreImageJobs,
  createUploadedImageJobs,
  clearImageProcessingJob,
  executeImageProcessingJob,
  fetchImageProcessingJobs,
  summarizeImageProcessingJobs,
  updateImageProcessingJob,
} from '../../lib/imageProcessingJobs.js';

const ACTIVE_STATUSES = new Set(['queued', 'processing', 'retrying']);
const EXECUTABLE_STATUSES = new Set(['processing', 'retrying']);
const REVIEW_STATUSES = new Set(['review', 'ready', 'completed']);
const APPROVED_STATUSES = new Set(['approved']);
const ARCHIVED_STATUSES = new Set(['archived']);
const CLEARABLE_STATUSES = new Set(['review', 'ready', 'completed', 'approved', 'failed', 'error', 'rejected']);
const EXECUTION_MARKER_PREFIX = 'proto:image-processing:execute:';
const EXECUTION_MARKER_TTL_MS = 10 * 60_000;
const PRODUCT_MANAGER_SLOTS = Object.freeze([
  { value: 1, label: 'Main product image', field: 'image_url_one' },
  { value: 2, label: 'Gallery image 2', field: 'image_url_two' },
  { value: 3, label: 'Gallery image 3', field: 'image_url_three' },
  { value: 4, label: 'Gallery image 4', field: 'image_url_four' },
]);
const PROCESSING_PRESETS = Object.freeze([
  { id: 'standard_opaque', label: 'Standard clean-up', description: 'Remove the background, centre the full product and prepare the white catalogue canvas.' },
  { id: 'shadow', label: 'Natural shadow', description: 'Keep a restrained product shadow while cleaning the background.' },
  { id: 'transparent_clear', label: 'Transparent packaging', description: 'Protect clear edges and printing; automatic cutout requires explicit operator confirmation.', requiresSafeCutout: true },
  { id: 'beads_fine_detail', label: 'Beads & fine detail', description: 'Protect beads, chains, findings and small holes; automatic cutout requires explicit confirmation.', requiresSafeCutout: true },
  { id: 'multi_piece', label: 'Multi-piece product', description: 'Preserve every piece and the exact pack quantity; automatic cutout requires explicit confirmation.', requiresSafeCutout: true },
  { id: 'measurements', label: 'Measurements', description: 'Source-preserving/manual lane for verified dimensions and measurement overlays.', manualOnly: true },
  { id: 'custom', label: 'Custom manual treatment', description: 'Source-preserving/manual lane for work that must not use a generic automatic cutout.', manualOnly: true },
]);
const EMPTY_REVIEW_CHECKLIST = Object.freeze({
  correctSku: false,
  labelsPreserved: false,
  cleanEdgesBackground: false,
  treatmentVerified: false,
});
const TREATMENT_REVIEW_IDS = new Set([
  'transparent_clear',
  'beads_fine_detail',
  'multi_piece',
  'custom',
  'targeted_reconstruction',
]);
const PRESERVATION_CONTENT_HINT = /\b(stickers?|labels?|barcodes?|printed\s+(?:words?|numbers?|text)|hangtags?|hang\s+tags?)\b/i;

function normalizedSku(value) {
  return String(value || '').trim().toUpperCase();
}

function productManagerSlot(value) {
  return PRODUCT_MANAGER_SLOTS.find((slot) => slot.value === Number(value)) || PRODUCT_MANAGER_SLOTS[0];
}

function executionMarkerKey(id) {
  return `${EXECUTION_MARKER_PREFIX}${id}`;
}

function hasRecentExecutionMarker(id) {
  try {
    const startedAt = Number(window.localStorage.getItem(executionMarkerKey(id)) || 0);
    if (startedAt && Date.now() - startedAt < EXECUTION_MARKER_TTL_MS) return true;
    window.localStorage.removeItem(executionMarkerKey(id));
  } catch { /* polling and the backend claim still guard execution */ }
  return false;
}

function markExecutionStarted(id) {
  try { window.localStorage.setItem(executionMarkerKey(id), String(Date.now())); } catch { /* ignore */ }
}

function clearExecutionMarker(id) {
  try { window.localStorage.removeItem(executionMarkerKey(id)); } catch { /* ignore */ }
}

function statusLabel(status) {
  return ({
    queued: 'Queued', processing: 'Processing', retrying: 'Retrying', review: 'Review',
    ready: 'Ready to review', completed: 'Ready to review', approved: 'Approved',
    rejected: 'Rejected', failed: 'Failed', error: 'Failed', archived: 'In Image Archive', published: 'Applied to Product Manager', restored: 'Original restored',
  })[status] || status;
}

function qualityFlagLabel(flag) {
  const key = typeof flag === 'string' ? flag : (flag?.code || flag?.label || 'quality_warning');
  return String(key).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function qualityFlagCode(flag) {
  return String(typeof flag === 'string' ? flag : (flag?.code || flag?.label || '')).trim().toLowerCase();
}

function isTreatmentReviewAdvisory(flag) {
  return /must_be_visually_verified|manual_review|manual_safe_cutout|manual_overlay|piece_count|fine_details|transparent_edges|custom_instructions|detached_label|barcode/.test(qualityFlagCode(flag));
}

function requiresTreatmentVerification(job) {
  if (!job) return false;
  if (TREATMENT_REVIEW_IDS.has(String(job.treatment || '').toLowerCase())) return true;
  return (job.qualityFlags || []).some((flag) => /transparent|bead|fine_detail|multi_piece|manual|repair|reconstruct/.test(qualityFlagCode(flag)));
}

function treatmentVerificationCopy(job) {
  const treatment = String(job?.treatment || '').toLowerCase();
  if (treatment === 'transparent_clear' || (job?.qualityFlags || []).some((flag) => /transparent/.test(qualityFlagCode(flag)))) {
    return 'Transparent edges, printing and clear packaging remain natural and complete.';
  }
  if (treatment === 'beads_fine_detail' || (job?.qualityFlags || []).some((flag) => /bead|fine_detail/.test(qualityFlagCode(flag)))) {
    return 'Every bead, chain, finding and fine edge is present; nothing has merged or disappeared.';
  }
  if (treatment === 'multi_piece' || (job?.qualityFlags || []).some((flag) => /multi_piece/.test(qualityFlagCode(flag)))) {
    return 'Every product piece and the advertised quantity are present and unchanged.';
  }
  return 'The manual repair changed only the intended area; the real product, branding and proportions remain unchanged.';
}

function ImageLightbox({ label, url, onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="ipc-image-lightbox" role="dialog" aria-modal="true" aria-label={`${label} full-size preview`} onClick={onClose}>
      <div className="ipc-image-lightbox__content" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>{label}</strong>
          <span>Full image Â· click outside or press Escape to close</span>
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={onClose} autoFocus><X size={15} /> Close</button>
        </header>
        <img src={url} alt={`${label} full-size product`} />
      </div>
    </div>
  );
}

function PreviewPane({ label, url, emptyText, websiteReady = false, onImageError }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  return (
    <figure className="ipc-preview-pane">
      <figcaption>{label}</figcaption>
      <div className={`ipc-preview-image${websiteReady ? ' ipc-preview-image--white' : ''}`}>
        {url ? (
          <button type="button" className="ipc-preview-open" onClick={() => setLightboxOpen(true)} aria-label={`View ${label} full size`}>
            <img src={url} alt={`${label} product`} onError={onImageError} />
            <span className="ipc-preview-open__hint"><ZoomIn size={14} /> Click to enlarge</span>
          </button>
        ) : <span><ImageOff size={22} />{emptyText}</span>}
      </div>
      {lightboxOpen && <ImageLightbox label={label} url={url} onClose={() => setLightboxOpen(false)} />}
    </figure>
  );
}

function RepairablePreviewPane({ label, url, emptyText, repairEnabled, selection, onSelectionChange, onImageError }) {
  const frameRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const [renderedRect, setRenderedRect] = useState(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const syncRenderedRect = useCallback(() => {
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image?.naturalWidth || !image?.naturalHeight) {
      setRenderedRect(null);
      return;
    }
    const scale = Math.min(frame.clientWidth / image.naturalWidth, frame.clientHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    setRenderedRect({
      x: (frame.clientWidth - width) / 2,
      y: (frame.clientHeight - height) / 2,
      width,
      height,
    });
  }, []);

  useEffect(() => {
    syncRenderedRect();
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(syncRenderedRect);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [syncRenderedRect, url]);

  const pointFromEvent = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      displayRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      x: Math.max(rect.left, Math.min(rect.right, event.clientX)),
      y: Math.max(rect.top, Math.min(rect.bottom, event.clientY)),
    };
  };

  const beginSelection = (event) => {
    if (!repairEnabled || event.button !== 0) return;
    const start = pointFromEvent(event);
    dragRef.current = start;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelectionChange?.({
      displayRect: start.displayRect,
      selection: { x: start.x, y: start.y, width: 0, height: 0 },
    });
  };

  const moveSelection = (event) => {
    const start = dragRef.current;
    if (!repairEnabled || !start) return;
    const point = pointFromEvent(event);
    onSelectionChange?.({
      displayRect: point.displayRect,
      selection: {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      },
    });
  };

  const finishSelection = () => {
    dragRef.current = null;
  };

  return (
    <figure className="ipc-preview-pane">
      <figcaption>{label}</figcaption>
      <div ref={frameRef} className="ipc-preview-image ipc-preview-image--white ipc-repair-frame">
        {url ? (
          <button type="button" className="ipc-preview-open" disabled={repairEnabled} onClick={() => setLightboxOpen(true)} aria-label={repairEnabled ? 'Finish targeted repair selection before enlarging this image' : `View ${label} full size`}>
            <img ref={imageRef} src={url} alt={`${label} product`} onLoad={syncRenderedRect} onError={onImageError} />
            {!repairEnabled && <span className="ipc-preview-open__hint"><ZoomIn size={14} /> Click to enlarge</span>}
          </button>
        ) : <span><ImageOff size={22} />{emptyText}</span>}
        {url && renderedRect && (
          <div
            className={`ipc-repair-layer${repairEnabled ? ' ipc-repair-layer--active' : ''}`}
            style={{ left: renderedRect.x, top: renderedRect.y, width: renderedRect.width, height: renderedRect.height }}
            onPointerDown={beginSelection}
            onPointerMove={moveSelection}
            onPointerUp={finishSelection}
            onPointerCancel={finishSelection}
            role={repairEnabled ? 'application' : undefined}
            aria-label={repairEnabled ? 'Draw a repair box over unwanted background only' : undefined}
          >
            {selection?.selection && (
              <span className="ipc-repair-selection" style={{ left: selection.selection.x - selection.displayRect.x, top: selection.selection.y - selection.displayRect.y, width: selection.selection.width, height: selection.selection.height }} />
            )}
          </div>
        )}
      </div>
      {lightboxOpen && <ImageLightbox label={label} url={url} onClose={() => setLightboxOpen(false)} />}
    </figure>
  );
}

export default function ImageProcessingCentre({
  nutstoreSelection = [],
  uploadSelection = [],
  intakeOptions,
  onIntakeOptionsChange,
  onNutstoreSelectionConsumed,
  onUploadSelectionConsumed,
  onShowToast,
  onOpenNutstore,
}) {
  const folderRef = useRef(null);
  const fileRef = useRef(null);
  const processInFlightRef = useRef('');
  const executionInFlightRef = useRef(new Set());
  const executionAuthorizationRef = useRef(new Set());
  const queueMutationVersionRef = useRef(0);
  const lastQueueMutationAtRef = useRef(0);
  const queueLoadSequenceRef = useRef(0);
  const previewRefreshInFlightRef = useRef(new Set());
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workerUnavailable, setWorkerUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [executionAuthorizationVersion, setExecutionAuthorizationVersion] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [slots, setSlots] = useState({});
  const [destination, setDestination] = useState({ status: 'idle', product: null, error: '' });
  const [destinationLookupAttempt, setDestinationLookupAttempt] = useState(0);
  const [destinationSearch, setDestinationSearch] = useState('');
  const [destinationCandidate, setDestinationCandidate] = useState({ status: 'idle', product: null, matchedBy: '', error: '' });
  const [queueView, setQueueView] = useState('queue');
  const [applyConfirmation, setApplyConfirmation] = useState(null);
  const [revisionAdjustments, setRevisionAdjustments] = useState({});
  const [processingPreset, setProcessingPreset] = useState(() => intakeOptions?.treatment || 'standard_opaque');
  const [customInstructions, setCustomInstructions] = useState(() => intakeOptions?.instructions || '');
  const [manualSafeCutout, setManualSafeCutout] = useState(false);
  const [nutstoreConnection, setNutstoreConnection] = useState({ status: 'checking', error: '' });
  const [reviewChecklists, setReviewChecklists] = useState({});
  const [repairModeJobId, setRepairModeJobId] = useState('');
  const [repairDraft, setRepairDraft] = useState(null);
  const [repairConfirmation, setRepairConfirmation] = useState(false);

  // Persist intake choices at the moment they change.  The centre is
  // intentionally unmounted while an owner browses Nutstore; relying only on
  // the effect below leaves a small window where a quick navigation can lose
  // the latest selection before the parent/storage has seen it.
  const rememberIntakeChange = useCallback((next) => {
    onIntakeOptionsChange?.(next);
  }, [onIntakeOptionsChange]);

  const summary = useMemo(() => summarizeImageProcessingJobs(jobs), [jobs]);
  const selectedJob = jobs.find((job) => job.id === selectedJobId) || jobs[0] || null;
  const selectedJobExecutionAuthorized = selectedJob
    ? executionAuthorizationRef.current.has(selectedJob.id)
    : false;
  const hasActiveJobs = jobs.some((job) => ACTIVE_STATUSES.has(job.status));
  const archivedJobs = jobs.filter((job) => ['archived', 'published', 'restored'].includes(job.status));
  const queuedJobs = jobs.filter((job) => !['archived', 'published', 'restored'].includes(job.status));
  const visibleJobs = queueView === 'archive' ? archivedJobs : queuedJobs;
  const workflowStep = selectedJob
    ? (['review', 'ready', 'completed'].includes(selectedJob.status)
      ? 3
      : (['approved', 'archived', 'published', 'restored'].includes(selectedJob.status) ? 4 : 2))
    : 1;
  const selectedSlot = productManagerSlot(slots[selectedJob?.id] || selectedJob?.destination?.slot || selectedJob?.targetSlot);
  const destinationProduct = destination.status === 'found' ? destination.product : null;
  const currentDestinationImage = destinationProduct?.[selectedSlot.field] || '';
  const selectedProcessingPreset = PROCESSING_PRESETS.find((preset) => preset.id === processingPreset) || PROCESSING_PRESETS[0];
  const intakeRequiresSafeCutout = selectedProcessingPreset.requiresSafeCutout === true;
  const intakeIsManualOnly = selectedProcessingPreset.manualOnly === true;
  const preservationContentRequested = PRESERVATION_CONTENT_HINT.test(customInstructions);
  const genericTreatmentWithPreservationContent = preservationContentRequested && processingPreset === 'standard_opaque';
  const intakeCanStart = !intakeIsManualOnly
    && !genericTreatmentWithPreservationContent
    && (!intakeRequiresSafeCutout || manualSafeCutout);
  const selectedReviewChecklist = reviewChecklists[selectedJob?.id] || EMPTY_REVIEW_CHECKLIST;
  const blockingQualityFlags = (selectedJob?.qualityFlags || []).filter((flag) => (
    qualityFlagCode(flag) !== 'quality_needs_attention'
    && !isTreatmentReviewAdvisory(flag)
  ));
  const treatmentVerificationRequired = requiresTreatmentVerification(selectedJob);
  const reviewChecklistComplete = Boolean(
    selectedReviewChecklist.correctSku
    && selectedReviewChecklist.labelsPreserved
    && selectedReviewChecklist.cleanEdgesBackground
    && (!treatmentVerificationRequired || selectedReviewChecklist.treatmentVerified)
  );
  const selectedRepairDraft = repairDraft?.jobId === selectedJob?.id ? repairDraft : null;
  const repairAreaRatio = selectedRepairDraft
    ? (selectedRepairDraft.selection.width * selectedRepairDraft.selection.height)
      / (selectedRepairDraft.displayRect.width * selectedRepairDraft.displayRect.height)
    : 0;
  const repairDraftValid = Boolean(
    selectedRepairDraft
    && selectedRepairDraft.selection.width >= 3
    && selectedRepairDraft.selection.height >= 3
    && repairAreaRatio > 0
    && repairAreaRatio <= 0.35
  );
  const processingOptions = useMemo(() => ({
    treatment: processingPreset,
    manualSafeCutout,
    instructions: customInstructions.trim(),
  }), [customInstructions, manualSafeCutout, processingPreset]);

  useEffect(() => {
    onIntakeOptionsChange?.({ treatment: processingPreset, instructions: customInstructions });
  }, [customInstructions, onIntakeOptionsChange, processingPreset]);

  useEffect(() => {
    setRepairModeJobId('');
    setRepairDraft(null);
    setRepairConfirmation(false);
  }, [selectedJob?.afterUrl, selectedJob?.displayedAssetId, selectedJob?.id]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/nutstore-browse?action=status', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.configured !== false) {
          setNutstoreConnection({ status: 'ready', error: '' });
        } else if (payload.configured === false) {
          setNutstoreConnection({ status: 'missing', error: '' });
        } else {
          setNutstoreConnection({ status: 'unreachable', error: payload.error || 'PTR Photos could not be checked.' });
        }
      })
      .catch((connectionError) => {
        if (connectionError?.name === 'AbortError') return;
        setNutstoreConnection({ status: 'unreachable', error: 'PTR Photos could not be checked.' });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const sku = normalizedSku(selectedJob?.destination?.sku || selectedJob?.sku);
    const shouldResolve = sku && ['approved', 'archived', 'published'].includes(selectedJob?.status);
    if (!shouldResolve) {
      setDestination({ status: 'idle', product: null, error: '' });
      return undefined;
    }

    const controller = new AbortController();
    setDestination({ status: 'loading', product: null, error: '' });
    fetch(`/api/product-loader-lookup?code=${encodeURIComponent(sku)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Could not check Product Manager');
        const product = payload.websiteRow || null;
        if (!product || normalizedSku(product.sku) !== sku) {
          setDestination({
            status: 'missing',
            product: null,
            error: `No exact Product Manager product matches SKU ${sku}.`,
          });
          return;
        }
        setDestination({ status: 'found', product, error: '' });
      })
      .catch((lookupError) => {
        if (lookupError?.name === 'AbortError') return;
        setDestination({ status: 'error', product: null, error: lookupError.message || 'Could not check Product Manager' });
      });
    return () => controller.abort();
  }, [destinationLookupAttempt, selectedJob?.destination?.sku, selectedJob?.sku, selectedJob?.status]);

  useEffect(() => {
    setDestinationSearch('');
    setDestinationCandidate({ status: 'idle', product: null, matchedBy: '', error: '' });
  }, [selectedJob?.id]);

  const mergeJobs = useCallback((incoming) => {
    setJobs((current) => {
      const byId = new Map(current.map((job) => [job.id, job]));
      for (const job of incoming) byId.set(job.id, { ...byId.get(job.id), ...job });
      return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    });
  }, []);

  const markQueueMutation = useCallback(() => {
    queueMutationVersionRef.current += 1;
    lastQueueMutationAtRef.current = Date.now();
  }, []);

  const authorizeExecution = useCallback((incoming) => {
    for (const job of incoming || []) {
      if (job?.id) executionAuthorizationRef.current.add(job.id);
    }
    setExecutionAuthorizationVersion((version) => version + 1);
  }, []);

  const loadJobs = useCallback(async ({ quiet = false } = {}) => {
    const loadSequence = ++queueLoadSequenceRef.current;
    const mutationVersion = queueMutationVersionRef.current;
    if (!quiet) setLoading(true);
    try {
      const rows = await fetchImageProcessingJobs();
      if (
        loadSequence !== queueLoadSequenceRef.current
        || mutationVersion !== queueMutationVersionRef.current
      ) return;
      setJobs((current) => {
        const hasLocallyActiveJob = current.some((job) => ACTIVE_STATUSES.has(job.status));
        const mutationIsRecent = Date.now() - lastQueueMutationAtRef.current < 30_000;
        // Do not let a briefly stale empty index erase work that this tab just
        // created. The durable backend listing remains authoritative after the
        // short consistency window.
        if (!rows.length && hasLocallyActiveJob && mutationIsRecent) return current;
        return rows;
      });
      setWorkerUnavailable(false);
      setError('');
    } catch (err) {
      if (
        loadSequence !== queueLoadSequenceRef.current
        || mutationVersion !== queueMutationVersionRef.current
      ) return;
      setWorkerUnavailable(true);
      setError(err.message || 'The image worker is unavailable');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshExpiredPreview = useCallback((jobId) => {
    if (!jobId || previewRefreshInFlightRef.current.has(jobId)) return;
    previewRefreshInFlightRef.current.add(jobId);
    void loadJobs({ quiet: true }).finally(() => {
      window.setTimeout(() => previewRefreshInFlightRef.current.delete(jobId), 3000);
    });
  }, [loadJobs]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  useEffect(() => {
    if (!hasActiveJobs) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      await loadJobs({ quiet: true });
      if (!stopped) timer = window.setTimeout(poll, 5000);
    };
    timer = window.setTimeout(poll, 3000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [hasActiveJobs, loadJobs]);

  useEffect(() => {
    for (const job of jobs) {
      if (!ACTIVE_STATUSES.has(job.status)) clearExecutionMarker(job.id);
    }
  }, [jobs]);

  useEffect(() => {
    if (!selectedJobId && jobs[0]?.id) setSelectedJobId(jobs[0].id);
  }, [jobs, selectedJobId]);

  const queueNutstore = async () => {
    if (!nutstoreSelection.length) return;
    markQueueMutation();
    setBusy('nutstore');
    setError('');
    try {
      const created = await createNutstoreImageJobs(nutstoreSelection, processingOptions);
      markQueueMutation();
      authorizeExecution(created);
      mergeJobs(created);
      setWorkerUnavailable(false);
      onNutstoreSelectionConsumed?.();
      onShowToast?.(`Added ${created.length} exact SKU review item${created.length === 1 ? '' : 's'} from Nutstore`, 'success');
    } catch (err) {
      setWorkerUnavailable(true);
      setError(err.message || 'Could not queue the Nutstore images');
    } finally {
      setBusy('');
    }
  };

  const queueUploads = async (fileList, { consumeHandoff = false } = {}) => {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      setError('No supported image files were found in that selection.');
      return;
    }
    markQueueMutation();
    setBusy('upload');
    setError('');
    try {
      const created = await createUploadedImageJobs(files, processingOptions);
      markQueueMutation();
      authorizeExecution(created);
      mergeJobs(created);
      setWorkerUnavailable(false);
      if (consumeHandoff) onUploadSelectionConsumed?.();
      onShowToast?.(`Added ${created.length} exact SKU review item${created.length === 1 ? '' : 's'} from ${files.length} image${files.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      setWorkerUnavailable(true);
      setError(err.message || 'Could not upload these images');
    } finally {
      setBusy('');
      if (folderRef.current) folderRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runAction = async (job, action, details = {}) => {
    if (action === 'retry') {
      setReviewChecklists((current) => ({ ...current, [job.id]: { ...EMPTY_REVIEW_CHECKLIST } }));
    }
    markQueueMutation();
    setBusy(`${action}:${job.id}`);
    setError('');
    try {
      const updated = await updateImageProcessingJob(job.id, action, details);
      markQueueMutation();
      if (action === 'retry') authorizeExecution([updated]);
      mergeJobs([updated]);
      if (action === 'archive') {
        setQueueView('archive');
        setSelectedJobId(updated.id);
      }
      setWorkerUnavailable(false);
      onShowToast?.(
        action === 'apply' ? `Applied ${job.filename} to Product Manager â€” ${productManagerSlot(details.imageSlot).label}` : `${statusLabel(action)}: ${job.filename}`,
        'success',
      );
      return updated;
    } catch (err) {
      setWorkerUnavailable(true);
      setError(err.message || `Could not ${action} this image`);
      return null;
    } finally {
      setBusy('');
    }
  };

  const setReviewConfirmation = (jobId, key, checked) => {
    setReviewChecklists((current) => ({
      ...current,
      [jobId]: {
        ...EMPTY_REVIEW_CHECKLIST,
        ...(current[jobId] || {}),
        [key]: checked,
      },
    }));
  };

  const setAllReviewConfirmations = (jobId, checked) => {
    setReviewChecklists((current) => ({
      ...current,
      [jobId]: {
        correctSku: checked,
        labelsPreserved: checked,
        cleanEdgesBackground: checked,
        treatmentVerified: checked,
      },
    }));
  };

  const approveSelectedJob = async () => {
    if (!selectedJob || !reviewChecklistComplete) return;
    await runAction(selectedJob, 'approve', {
      reviewChecklist: {
        correctSku: selectedReviewChecklist.correctSku === true,
        labelsPreserved: selectedReviewChecklist.labelsPreserved === true,
        cleanEdgesBackground: selectedReviewChecklist.cleanEdgesBackground === true,
        treatmentVerified: selectedReviewChecklist.treatmentVerified === true,
      },
    });
  };

  const assignCandidateSku = async (job, sku) => {
    const exactSku = normalizedSku(sku);
    if (!exactSku) return;
    setReviewChecklists((current) => ({ ...current, [job.id]: { ...EMPTY_REVIEW_CHECKLIST } }));
    await runAction(job, 'assign_destination', {
      destinationSku: exactSku,
      imageSlot: productManagerSlot(job.destination?.slot || job.targetSlot).value,
    });
  };

  const submitTargetedRepair = async (job) => {
    if (
      repairDraft?.jobId !== job.id
      || repairDraft?.displayedAssetId !== job.displayedAssetId
      || repairDraft.selection.width < 3
      || repairDraft.selection.height < 3
    ) return;
    const updated = await runAction(job, 'targeted_repair', {
      displayedAssetId: repairDraft.displayedAssetId,
      displayRect: repairDraft.displayRect,
      selection: repairDraft.selection,
    });
    if (!updated) return;
    setSelectedJobId(updated.id);
    setQueueView('queue');
    setRepairModeJobId('');
    setRepairDraft(null);
    setRepairConfirmation(false);
    onShowToast?.('Created a new targeted-repair review result. The original review asset is unchanged.', 'success');
  };

  const findProductManagerDestination = async () => {
    const code = destinationSearch.trim();
    if (!code) {
      setDestinationCandidate({ status: 'error', product: null, matchedBy: '', error: 'Enter a Product Manager SKU, barcode or product name first.' });
      return;
    }
    setDestinationCandidate({ status: 'loading', product: null, matchedBy: '', error: '' });
    try {
      const response = await fetch(`/api/product-loader-lookup?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not search Product Manager');
      if (!payload.websiteRow?.sku) throw new Error('No Product Manager product was found. Try its SKU or barcode.');
      setDestinationCandidate({ status: 'found', product: payload.websiteRow, matchedBy: payload.matchedBy || 'search', error: '' });
    } catch (lookupError) {
      setDestinationCandidate({ status: 'error', product: null, matchedBy: '', error: lookupError.message || 'Could not search Product Manager' });
    }
  };

  const useProductManagerDestination = async (job) => {
    const product = destinationCandidate.product;
    if (!product?.sku) return;
    const updated = await runAction(job, 'assign_destination', { destinationSku: product.sku, imageSlot: selectedSlot.value });
    if (!updated) return;
    setDestination({ status: 'found', product, error: '' });
    onShowToast?.(`Saved ${product.sku} as the proposed Product Manager destination. Nothing has been sent.`, 'success');
  };

  const requestProductManagerApply = (job) => {
    if (!job.archive?.assetId || !destinationProduct) return;
    setApplyConfirmation({ jobId: job.id, assetId: job.archive.assetId });
  };

  const confirmProductManagerApply = async (job) => {
    if (applyConfirmation?.jobId !== job.id || applyConfirmation.assetId !== job.archive?.assetId) return;
    const updated = await runAction(job, 'apply', {
      imageSlot: selectedSlot.value,
      publishToExistingSlot: Boolean(currentDestinationImage),
      confirmArchiveAssetId: job.archive.assetId,
    });
    if (updated) setApplyConfirmation(null);
  };

  const createArchiveRevision = async (job) => {
    const adjustments = revisionAdjustments[job.id] || { paddingRatio: 0.08, background: '#FFFFFF', shadow: 'none' };
    const updated = await runAction(job, 'create_revision', { adjustments });
    if (!updated) return;
    setSelectedJobId(updated.id);
    setQueueView('queue');
    onShowToast?.(`Created revision ${updated.revision?.number || 'new'} from the retained transparent master. The archive original remains unchanged.`, 'success');
  };

  const clearJob = async (job) => {
    const approvedWarning = job.status === 'approved' ? ' This discards the approved staged result before it is saved to the Image Archive.' : '';
    const confirmed = window.confirm(`Clear ${job.filename} from the queue? This removes its private upload and staged processed preview.${approvedWarning} It does not change any product or Nutstore image.`);
    if (!confirmed) return;
    markQueueMutation();
    setBusy(`clear:${job.id}`);
    setError('');
    try {
      await clearImageProcessingJob(job.id);
      markQueueMutation();
      setJobs((current) => current.filter((row) => row.id !== job.id));
      setSelectedJobId('');
      clearExecutionMarker(job.id);
      setWorkerUnavailable(false);
      onShowToast?.(`Cleared ${job.filename} from the processing queue`, 'success');
    } catch (err) {
      // Preview deployments can retain queue rows from an older ephemeral
      // store. If the API confirms the row no longer exists, remove the stale
      // client entry so a clean test run is still possible.
      if (err?.status === 404) {
        setJobs((current) => current.filter((row) => row.id !== job.id));
        setSelectedJobId('');
        clearExecutionMarker(job.id);
        setWorkerUnavailable(false);
        onShowToast?.(`Removed stale ${job.filename} from the preview queue`, 'success');
        return;
      }
      setWorkerUnavailable(true);
      setError(err.message || 'Could not clear this image from the queue');
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    if (busy || processInFlightRef.current) return undefined;
    const resumable = jobs.find((job) => (
      executionAuthorizationRef.current.has(job.id)
      && EXECUTABLE_STATUSES.has(job.status)
      && !executionInFlightRef.current.has(job.id)
      && !hasRecentExecutionMarker(job.id)
    ));
    const candidate = resumable || jobs.find((job) => (
      job.status === 'queued' && executionAuthorizationRef.current.has(job.id)
    ));
    if (!candidate) return undefined;

    processInFlightRef.current = candidate.id;
    markQueueMutation();
    setBusy(`${candidate.status === 'queued' ? 'process' : 'execute'}:${candidate.id}`);
    setError('');
    void (async () => {
      try {
        let updated = candidate;
        if (candidate.status === 'queued') {
          updated = await updateImageProcessingJob(candidate.id, 'process');
          markQueueMutation();
          mergeJobs([updated]);
        }

        if (EXECUTABLE_STATUSES.has(updated.status)) {
          executionInFlightRef.current.add(candidate.id);
          markExecutionStarted(candidate.id);
          setBusy(`execute:${candidate.id}`);
          updated = await executeImageProcessingJob(candidate.id);
          markQueueMutation();
          mergeJobs([updated]);
        }
        setWorkerUnavailable(false);
      } catch (err) {
        const stillPolling = err.code === 'IMAGE_EXECUTION_PENDING';
        setWorkerUnavailable(!stillPolling);
        setError(err.message || `Could not process ${candidate.filename}`);
        await loadJobs({ quiet: true });
      } finally {
        executionInFlightRef.current.delete(candidate.id);
        processInFlightRef.current = '';
        setBusy('');
      }
    })();
    return undefined;
  }, [busy, executionAuthorizationVersion, jobs, loadJobs, markQueueMutation, mergeJobs]);

  const runBulkReviewAction = async (action) => {
    const candidates = jobs.filter((job) => REVIEW_STATUSES.has(job.status));
    if (!candidates.length) return;
    markQueueMutation();
    setBusy(`bulk:${action}`);
    setError('');
    try {
      const updated = [];
      for (const job of candidates) {
        if (action === 'archive') {
          throw new Error('Bulk archive is disabled. Approve each result after human review, then save the approved result to the Image Archive.');
        }
        updated.push(await updateImageProcessingJob(job.id, action));
      }
      markQueueMutation();
      mergeJobs(updated);
      setWorkerUnavailable(false);
      onShowToast?.(`${action === 'archive' ? 'Saved to the Image Archive' : 'Rejected'} ${updated.length} reviewed image${updated.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      setError(err.message || `Could not ${action} the reviewed batch`);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="pl-section ipc-centre" aria-labelledby="ipc-title">
      <div className="ipc-hero">
        <div>
          <span className="ipc-eyebrow"><Sparkles size={14} /> Owner workspace</span>
          <h3 id="ipc-title">Image Processing Centre</h3>
          <p>Prepare a website-ready image, complete manual human review, then save it to the controlled Image Archive. Product Manager placement is a separate, explicitly confirmed action.</p>
        </div>
        <button type="button" className="adm-btn-ghost" onClick={() => void loadJobs()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh queue
        </button>
      </div>

      <ol className="ipc-steps" aria-label="Image processing workflow">
        {[
          ['Choose treatment', 'Set the safe processing lane.'],
          ['Add images', 'Bring in Nutstore or local files.'],
          ['Review result', 'Check the image and quality flags.'],
          ['Archive or apply', 'Save privately, then explicitly apply.'],
        ].map(([title, description], index) => {
          const step = index + 1;
          return (
            <li key={title} className={`ipc-step${workflowStep === step ? ' ipc-step--active' : ''}${workflowStep > step ? ' ipc-step--done' : ''}`}>
              <span>{workflowStep > step ? 'âœ“' : step}</span>
              <div><strong>{title}</strong><small>{description}</small></div>
            </li>
          );
        })}
      </ol>

      <div className="ipc-readiness-note" role="status">
        <CheckCircle size={17} />
        <div><strong>Website-ready standard</strong><span>Approved archive versions use a clean white 1600 Ã— 1600 canvas. The original upload and transparent cleaned master are retained privately for restoration and future adjustments. Checks flag clutter, crop and centring, canvas consistency, clarity, lighting and ambiguous labels for human review.</span></div>
      </div>

      {nutstoreConnection.status === 'missing' && (
        <div className="ipc-config-warning" role="status">
          <AlertTriangle size={18} />
          <div>
            <strong>PTR Photos is not connected in this deployment</strong>
            <span>An administrator must add the approved <code>NUTSTORE_USER</code> and <code>NUTSTORE_APP_PASSWORD</code> variables to this Vercel environment, then redeploy. Never enter a Nutstore password on this page or share it in chat. Local image upload remains available.</span>
          </div>
        </div>
      )}
      {nutstoreConnection.status === 'unreachable' && (
        <div className="ipc-config-warning" role="status">
          <AlertTriangle size={18} />
          <div><strong>PTR Photos could not be reached</strong><span>{nutstoreConnection.error} Check the approved Vercel environment configuration and Nutstore service status; local image upload remains available.</span></div>
        </div>
      )}

      <fieldset className="ipc-presets" disabled={Boolean(busy)}>
        <legend>Choose treatment before adding images</legend>
        <div className="ipc-preset-grid">
          {PROCESSING_PRESETS.map((preset) => (
            <label key={preset.id} className={`ipc-preset${processingPreset === preset.id ? ' ipc-preset--on' : ''}`}>
              <input type="radio" name="image-processing-preset" value={preset.id} checked={processingPreset === preset.id} onChange={() => {
                setProcessingPreset(preset.id);
                setManualSafeCutout(false);
                rememberIntakeChange({ treatment: preset.id, instructions: customInstructions });
              }} />
              <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
            </label>
          ))}
        </div>
        {intakeRequiresSafeCutout && (
          <label className="ipc-safe-cutout-confirmation">
            <input type="checkbox" checked={manualSafeCutout} onChange={(event) => setManualSafeCutout(event.target.checked)} />
            <span><strong>I inspected these source images and confirm an automatic cutout is safe.</strong><small>The processor may remove background pixels only. It must preserve every product part, transparent edge, label, word, number and pack quantity. Leave this unticked to block automatic processing.</small></span>
          </label>
        )}
        {processingPreset === 'beads_fine_detail' && (
          <div className="ipc-manual-lane-note" role="status">
            <AlertTriangle size={15} />
            <span><strong>Printed bead cards need extra care.</strong> If the source has number strips, labels or pale packaging, leave automatic cutout off and use a protected/manual treatment. The processor will block results when source content appears to disappear.</span>
          </div>
        )}
        {genericTreatmentWithPreservationContent && (
          <div className="ipc-manual-lane-note" role="alert">
            <AlertTriangle size={15} />
            <span><strong>Sticker/label preservation requires a protected treatment.</strong> Select â€œBeads &amp; fine detailâ€ before adding these images. Generic clean-up is blocked so printed product content cannot be removed.</span>
          </div>
        )}
        {intakeIsManualOnly && (
          <div className="ipc-manual-lane-note" role="status">
            <AlertTriangle size={15} />
            <span><strong>This is a source-preserving/manual lane.</strong> Generic automatic background removal is disabled. Add images only after the matching manual overlay or processed-asset repair workflow is available.</span>
          </div>
        )}
        <label className="ipc-instructions" htmlFor="ipc-instructions">
          Optional instructions for this intake
          <textarea id="ipc-instructions" aria-describedby="ipc-instructions-help" value={customInstructions} onChange={(event) => {
            const instructions = event.target.value.slice(0, 1_500);
            setCustomInstructions(instructions);
            rememberIntakeChange({ treatment: processingPreset, instructions });
          }} maxLength={1500} rows={2} placeholder="Example: preserve the hanging label and every printed measurement; remove only the damaged outer packaging." />
          <small id="ipc-instructions-help">{customInstructions.length}/1500 Â· Instructions are saved with each queued review item.</small>
        </label>
      </fieldset>

      {workerUnavailable && (
        <div className="ipc-worker-warning" role="status">
          <AlertTriangle size={17} />
          <div><strong>Processing unavailable</strong><span>{error || 'The image service could not be reached. Existing Product Loader tools remain available; retry when the service is available.'}</span></div>
          <button type="button" className="adm-btn-ghost adm-btn--sm" onClick={() => void loadJobs()}>Retry</button>
        </div>
      )}
      {!workerUnavailable && error && <p className="pl-error" role="alert">{error}</p>}

      <div className="ipc-sources">
        <article className="ipc-source-card">
          <div className="ipc-source-icon"><FolderOpen size={19} /></div>
          <div><strong>Selected from Nutstore</strong><span>{nutstoreSelection.length ? `${nutstoreSelection.length} image(s) waiting to be added` : 'Choose source images in PTR Photos, then return here to process them.'}</span></div>
          {nutstoreSelection.length > 0 && intakeRequiresSafeCutout && !manualSafeCutout && (
            <div className="ipc-manual-lane-note ipc-handoff-safety-note" role="status">
              <AlertTriangle size={14} />
              <span>Treatment and instructions were restored from your Nutstore handoff. Re-confirm the safety checkbox before adding these images.</span>
            </div>
          )}
          <div className="ipc-source-actions">
            {onOpenNutstore && <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={onOpenNutstore}><FolderOpen size={14} /> Open Nutstore</button>}
            <button type="button" className="adm-btn-red" disabled={!nutstoreSelection.length || Boolean(busy) || nutstoreConnection.status === 'missing' || !intakeCanStart} onClick={() => void queueNutstore()}>
              {busy === 'nutstore' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Add selected
            </button>
          </div>
        </article>
        <article className="ipc-source-card">
          <div className="ipc-source-icon"><Upload size={19} /></div>
          <div><strong>Upload from this computer</strong><span>{uploadSelection.length ? `${uploadSelection.length} image(s) handed over from Product Loader Upload.` : 'Choose loose images or an entire supplier folder. Original filenames are preserved.'}</span></div>
          <div className="ipc-source-actions">
            {uploadSelection.length > 0 && <button type="button" className="adm-btn-red" disabled={Boolean(busy) || !intakeCanStart} onClick={() => void queueUploads(uploadSelection, { consumeHandoff: true })}>{busy === 'upload' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Add handed-over images</button>}
            <button type="button" className="adm-btn-red" disabled={Boolean(busy) || !intakeCanStart} onClick={() => folderRef.current?.click()}><FolderOpen size={14} /> Folder</button>
            <button type="button" className="adm-btn-ghost" disabled={Boolean(busy) || !intakeCanStart} onClick={() => fileRef.current?.click()}>Images</button>
          </div>
          <input ref={folderRef} className="ipc-file-input" type="file" accept="image/*" multiple webkitdirectory="" onChange={(event) => void queueUploads(event.target.files)} />
          <input ref={fileRef} className="ipc-file-input" type="file" accept="image/*" multiple onChange={(event) => void queueUploads(event.target.files)} />
        </article>
      </div>

      <div className="ipc-summary" aria-label="Processing summary" aria-live="polite">
        <div><strong>{summary.total}</strong><span>Total images</span></div>
        <div><strong>{summary.processing}</strong><span>Processing</span></div>
        <div><strong>{summary.review}</strong><span>Needs review</span></div>
        <div><strong>{summary.approved}</strong><span>In archive</span></div>
        <div><strong>{summary.failed}</strong><span>Issues</span></div>
        <div className="ipc-summary-cost"><strong>R {summary.cost.toFixed(2)}</strong><span>Estimated batch cost</span></div>
      </div>

      {summary.review > 0 && (
        <div className="ipc-bulk-review" role="group" aria-label="Bulk review actions">
          <div><strong>{summary.review} processed image{summary.review === 1 ? '' : 's'} awaiting review</strong><span>Saving to the archive never changes Product Manager or the live website. Each asset can be adjusted, assigned and applied later.</span></div>
          <button type="button" className="adm-btn-red" disabled={Boolean(busy)} onClick={() => void runBulkReviewAction('archive')}><Archive size={14} /> Save all reviewed to archive</button>
          <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void runBulkReviewAction('reject')}><X size={14} /> Reject all reviewed</button>
        </div>
      )}

      <div className="ipc-workspace">
        <aside className="ipc-queue" aria-label="Image asset queue and archive">
          <header><strong>Image assets</strong><span>{jobs.length}</span></header>
          <div className="ipc-queue-tabs" role="tablist" aria-label="Image asset location">
            <button id="ipc-queue-tab" type="button" role="tab" aria-selected={queueView === 'queue'} aria-controls="ipc-queue-panel" className={`ipc-queue-tab${queueView === 'queue' ? ' ipc-queue-tab--on' : ''}`} onClick={() => setQueueView('queue')}>Processing queue <span>{queuedJobs.length}</span></button>
            <button id="ipc-archive-tab" type="button" role="tab" aria-selected={queueView === 'archive'} aria-controls="ipc-queue-panel" className={`ipc-queue-tab${queueView === 'archive' ? ' ipc-queue-tab--on' : ''}`} onClick={() => setQueueView('archive')}><Archive size={12} /> History & archive <span>{archivedJobs.length}</span></button>
          </div>
          <div id="ipc-queue-panel" role="tabpanel" aria-labelledby={queueView === 'archive' ? 'ipc-archive-tab' : 'ipc-queue-tab'}>
          {loading && !jobs.length ? (
            <p className="ipc-empty"><Loader2 size={16} className="spin" /> Loading queueâ€¦</p>
          ) : visibleJobs.length ? visibleJobs.map((job) => (
            <button key={job.id} type="button" className={`ipc-queue-row${selectedJob?.id === job.id ? ' ipc-queue-row--on' : ''}`} onClick={() => setSelectedJobId(job.id)}>
              <span className={`ipc-status-dot ipc-status-dot--${job.status}`} />
              <span className="ipc-queue-copy"><strong>{job.filename}</strong><small>{job.sku || (job.source === 'nutstore' ? 'Nutstore' : 'Local upload')}</small></span>
              <span className={`ipc-status ipc-status--${job.status}`}>{statusLabel(job.status)}</span>
            </button>
          )) : (
            <div className="ipc-empty">{queueView === 'archive' ? <Archive size={22} /> : <Sparkles size={22} />}<strong>{queueView === 'archive' ? 'No archived images yet' : 'No images queued'}</strong><span>{queueView === 'archive' ? 'Reviewed results saved here stay private and separate from processing assets.' : 'Add selected Nutstore images or upload a folder to begin.'}</span><small>{queueView === 'archive' ? 'Archive is private until you explicitly apply an approved image.' : 'Choose a treatment above, then add your first image to start.'}</small></div>
          )}
          </div>
        </aside>

        <div className="ipc-review">
          {selectedJob ? (
            <>
              <header className="ipc-review-head">
                <div><span className={`ipc-status ipc-status--${selectedJob.status}`}>{statusLabel(selectedJob.status)}</span><h4>{selectedJob.filename}</h4><p>{selectedJob.sku ? `Product ${selectedJob.sku}` : 'Product code will be matched from the filename'} Â· {selectedJob.source === 'nutstore' ? 'Nutstore' : 'Local upload'}</p></div>
                <div className="ipc-cost"><span>Processing cost</span><strong>R {selectedJob.estimatedCost.toFixed(2)}</strong></div>
              </header>
              {selectedJob.multiSkuSource && (
                <div className="ipc-multi-sku-note" role="status">
                  <CheckCircle size={16} />
                  <div>
                    <strong>Multi-SKU photo: choose the exact product for this one processed asset</strong>
                    <span>This source contains candidates {selectedJob.skuMappings.join(', ')}. Processing is charged once; choosing a SKU only changes the proposed Product Manager destination.</span>
                    {REVIEW_STATUSES.has(selectedJob.status) && (
                      <div className="ipc-sku-candidates" role="group" aria-label="Choose exact SKU for this processed image">
                        {selectedJob.skuMappings.map((sku) => {
                          const selectedSku = normalizedSku(selectedJob.destination?.sku || selectedJob.sku);
                          return <button key={sku} type="button" className={selectedSku === sku ? 'adm-btn-red adm-btn--sm' : 'adm-btn-ghost adm-btn--sm'} disabled={Boolean(busy)} onClick={() => void assignCandidateSku(selectedJob, sku)}>{sku}</button>;
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="ipc-comparison">
                <PreviewPane label="Original retained" url={selectedJob.beforeUrl} emptyText="Original preview pending" onImageError={() => refreshExpiredPreview(selectedJob.id)} />
                <RepairablePreviewPane
                  label="Website-ready white 1600 Ã— 1600"
                  url={selectedJob.afterUrl}
                  emptyText={ACTIVE_STATUSES.has(selectedJob.status) ? 'Processingâ€¦' : 'Website-ready preview unavailable'}
                  repairEnabled={repairModeJobId === selectedJob.id}
                  selection={selectedRepairDraft}
                  onImageError={() => refreshExpiredPreview(selectedJob.id)}
                  onSelectionChange={(geometry) => {
                    setRepairConfirmation(false);
                    setRepairDraft({ jobId: selectedJob.id, displayedAssetId: selectedJob.displayedAssetId, ...geometry });
                  }}
                />
              </div>
              {REVIEW_STATUSES.has(selectedJob.status) && selectedJob.afterUrl && selectedJob.displayedAssetId && (
                <div className="ipc-targeted-repair">
                  {repairModeJobId === selectedJob.id ? (
                    <>
                      <div><strong>Targeted background repair</strong><span>Draw one red box directly on the processed image. Select unwanted background onlyâ€”never a product, label, transparent edge or measurement.</span></div>
                      {selectedRepairDraft && !repairDraftValid && <p>The box must be at least 3 px wide/high and no more than 35% of the displayed image.</p>}
                      <div className="ipc-targeted-repair-actions">
                        <button type="button" className="adm-btn-red adm-btn--sm" disabled={!repairDraftValid || Boolean(busy)} onClick={() => setRepairConfirmation(true)}>Review repair selection</button>
                        <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy)} onClick={() => { setRepairModeJobId(''); setRepairDraft(null); setRepairConfirmation(false); }}>Cancel repair</button>
                      </div>
                    </>
                  ) : (
                    <><div><strong>Need to remove one remaining background mark?</strong><span>Use a precise red-box repair on this exact processed asset. A new result will return to review; nothing is archived or applied live.</span></div><button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy)} onClick={() => { setRepairModeJobId(selectedJob.id); setRepairDraft(null); setRepairConfirmation(false); }}>Draw targeted repair box</button></>
                  )}
                  {repairConfirmation && repairDraftValid && (
                    <div className="ipc-repair-confirmation" role="alertdialog" aria-label="Confirm targeted background repair">
                      <AlertTriangle size={16} />
                      <div><strong>Confirm one additional targeted repair request</strong><span>This sends the exact red-box geometry against asset <code>{selectedJob.displayedAssetId}</code>. It may incur one additional fal.ai provider charge; the exact cost is not confirmed. It creates a new private review result and does not change Product Manager or the website.</span></div>
                      <button type="button" className="adm-btn-red adm-btn--sm" disabled={Boolean(busy)} onClick={() => void submitTargetedRepair(selectedJob)}>Confirm repair request</button>
                      <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy)} onClick={() => setRepairConfirmation(false)}>Go back</button>
                    </div>
                  )}
                </div>
              )}
              <div className="ipc-asset-line" aria-label="Retained image versions">
                <Archive size={15} />
                <div><strong>Archive versions are retained</strong><span>Original upload Â· transparent cleaned master Â· white-background website-ready version</span></div>
              </div>
              <div className="ipc-quality">
                <div><strong>Quality check</strong>{selectedJob.qualityScore != null && <span className="ipc-score">{Math.round(Number(selectedJob.qualityScore))}/100</span>}</div>
                {selectedJob.qualityFlags.length ? (
                  <ul>{selectedJob.qualityFlags.map((flag, index) => <li key={`${qualityFlagLabel(flag)}-${index}`}><AlertTriangle size={13} /> {qualityFlagLabel(flag)}</li>)}</ul>
                ) : selectedJob.qualityScore == null
                  ? <p><AlertTriangle size={14} /> Quality assessment is incomplete. Inspect the output before approval.</p>
                  : <p><CheckCircle size={14} /> Automated checks passed. Complete the visual review before approval.</p>}
              </div>
              {REVIEW_STATUSES.has(selectedJob.status) && (
                <fieldset className="ipc-review-checklist">
                  <legend>Required human review</legend>
                  <label className="ipc-review-checklist-primary"><input type="checkbox" checked={reviewChecklistComplete} onChange={(event) => setAllReviewConfirmations(selectedJob.id, event.target.checked)} /><span><strong>I reviewed the enlarged image and confirm it is correct</strong><small>Check the SKU, labels/quantity, edges/background and the treatment warning where shown.</small></span></label>
                  <details className="ipc-review-checklist-details"><summary>Show individual checks</summary>
                    <label><input type="checkbox" checked={selectedReviewChecklist.correctSku} onChange={(event) => setReviewConfirmation(selectedJob.id, 'correctSku', event.target.checked)} /><span><strong>Correct SKU and product parts</strong><small>The chosen exact SKU matches this image and every visible product part belongs to it.</small></span></label>
                    <label><input type="checkbox" checked={selectedReviewChecklist.labelsPreserved} onChange={(event) => setReviewConfirmation(selectedJob.id, 'labelsPreserved', event.target.checked)} /><span><strong>Labels, text and quantity preserved</strong><small>Branding, words, numbers, measurements and advertised pack quantity are unchanged and legible.</small></span></label>
                    <label><input type="checkbox" checked={selectedReviewChecklist.cleanEdgesBackground} onChange={(event) => setReviewConfirmation(selectedJob.id, 'cleanEdgesBackground', event.target.checked)} /><span><strong>Clean edges and background</strong><small>No clipped edges, halos, stray pixels, unwanted objects or false product detail remain.</small></span></label>
                    {treatmentVerificationRequired && <label className="ipc-review-checklist-special"><input type="checkbox" checked={selectedReviewChecklist.treatmentVerified} onChange={(event) => setReviewConfirmation(selectedJob.id, 'treatmentVerified', event.target.checked)} /><span><strong>Treatment-specific verification</strong><small>{treatmentVerificationCopy(selectedJob)}</small></span></label>}
                  </details>
                  {!reviewChecklistComplete && <p>Approve unlocks after you confirm the enlarged image above.</p>}
                </fieldset>
              )}
              {selectedJob.error && <p className="ipc-job-error"><AlertTriangle size={14} /> {selectedJob.error}</p>}
              <div className="ipc-review-actions">
                {REVIEW_STATUSES.has(selectedJob.status) && <>
                  <button type="button" className="adm-btn-red" disabled={Boolean(busy) || selectedJob.qualityScore == null || blockingQualityFlags.length > 0 || !reviewChecklistComplete} onClick={() => void approveSelectedJob()}><Check size={14} /> Approve result</button>
                  <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void runAction(selectedJob, 'reject')}><X size={14} /> Reject</button>
                  <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void runAction(selectedJob, 'retry')}><RotateCcw size={14} /> Process again</button>
                </>}
                {['failed', 'error', 'rejected'].includes(selectedJob.status) && <button type="button" className="adm-btn-red" disabled={Boolean(busy)} onClick={() => void runAction(selectedJob, 'retry')}><RotateCcw size={14} /> Retry processing</button>}
                {CLEARABLE_STATUSES.has(selectedJob.status) && <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void clearJob(selectedJob)}><Trash2 size={14} /> {selectedJob.status === 'approved' ? 'Discard staged image' : 'Clear from queue'}</button>}
                {ACTIVE_STATUSES.has(selectedJob.status) && !selectedJobExecutionAuthorized && <button type="button" className="adm-btn-red" disabled={Boolean(busy)} onClick={() => authorizeExecution([selectedJob])}><Sparkles size={14} /> {selectedJob.status === 'queued' ? 'Start processing' : 'Resume processing'}</button>}
                {ACTIVE_STATUSES.has(selectedJob.status) && <span className="ipc-wait"><Clock3 size={14} /> {selectedJobExecutionAuthorized ? (selectedJob.status === 'processing' ? 'Removing the background and preparing the catalogue imageâ€¦' : 'Waiting to start; this page will process this explicitly authorized image.') : 'Recovered safely. Processing will not start until you click the button.'}</span>}
              </div>
              {APPROVED_STATUSES.has(selectedJob.status) && (
                <div className="ipc-publish-box">
                  <div className="ipc-destination-copy">
                    <span className="ipc-destination-eyebrow"><CheckCircle size={12} /> Approved for archive</span>
                    <strong>Save the approved result before choosing any live destination</strong>
                    <span>This creates a retained white-background 1600 Ã— 1600 archive asset. It does not change Product Manager or the website.</span>
                  </div>
                  <button type="button" className="adm-btn-red" disabled={Boolean(busy)} onClick={() => void runAction(selectedJob, 'archive')}><Archive size={14} /> Save approved result to Image Archive</button>
                </div>
              )}
              {(ARCHIVED_STATUSES.has(selectedJob.status) || selectedJob.status === 'published') && (
                <div className="ipc-publish-box">
                  <div className="ipc-destination-copy">
                    <span className="ipc-destination-eyebrow"><Archive size={12} /> Controlled Image Archive</span>
                    <strong>{selectedJob.status === 'published' ? 'Previously applied image retained in archive' : 'Saved in the Image Archive'}</strong>
                    <span>{selectedJob.status === 'published'
                      ? 'This website-ready white 1600 Ã— 1600 version has already been applied to Product Manager. Its archive record remains available for traceability and restore.'
                      : 'This website-ready white 1600 Ã— 1600 version is staged only. It has not changed Product Manager or the live website.'}
                    </span>
                    {destination.status === 'loading' && <span>Checking a proposed Product Manager destinationâ€¦</span>}
                    {destinationProduct && (
                      <div className="ipc-destination-product">
                        <div className="ipc-destination-current-image">
                          {currentDestinationImage ? <img src={currentDestinationImage} alt={`Current ${selectedSlot.label} for ${destinationProduct.title || destinationProduct.sku}`} /> : <ImageOff size={20} />}
                        </div>
                        <div>
                          <span className="ipc-destination-confirmed"><CheckCircle size={13} /> Proposed Product Manager destination</span>
                          <strong>{destinationProduct.title || 'Untitled product'}</strong>
                          <span>SKU {destinationProduct.sku}</span>
                          <span>{selectedSlot.label} Â· {currentDestinationImage ? 'Current product image shown for later comparison. No replacement is being made here.' : 'This position is empty. No image is being added here.'}</span>
                        </div>
                      </div>
                    )}
                    {['missing', 'error'].includes(destination.status) && (
                      <div className="ipc-destination-blocked"><AlertTriangle size={13} /> <span>{destination.error} This archive asset stays private until you deliberately choose its proposed Product Manager product below.</span>
                        {selectedJob.status !== 'published' && <div className="ipc-destination-lookup">
                          <label>Find Product Manager product<input value={destinationSearch} onChange={(event) => setDestinationSearch(event.target.value)} placeholder="SKU, barcode or product name" /></label>
                          <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy) || destinationCandidate.status === 'loading'} onClick={() => void findProductManagerDestination()}>{destinationCandidate.status === 'loading' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Find product</button>
                        </div>}
                        {destinationCandidate.status === 'error' && <span>{destinationCandidate.error}</span>}
                        {destinationCandidate.status === 'found' && <div className="ipc-destination-candidate"><strong>{destinationCandidate.product.title || 'Untitled product'}</strong><span>SKU {destinationCandidate.product.sku} Â· matched by {destinationCandidate.matchedBy}</span><button type="button" className="adm-btn-red adm-btn--sm" disabled={Boolean(busy)} onClick={() => void useProductManagerDestination(selectedJob)}><Check size={14} /> Stage this Product Manager destination</button></div>}
                      </div>
                    )}
                    {destination.status === 'idle' && <span>You may look up a Product Manager product now, but this remains a staged intent only.</span>}
                  </div>
                  {selectedJob.status !== 'published' && <label>Proposed image position<select value={selectedSlot.value} onChange={(event) => setSlots((current) => ({ ...current, [selectedJob.id]: Number(event.target.value) }))}>{PRODUCT_MANAGER_SLOTS.map((slot) => <option key={slot.value} value={slot.value}>{slot.label}</option>)}</select></label>}
                  {destination.status === 'error' && selectedJob.status !== 'published' && <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => setDestinationLookupAttempt((attempt) => attempt + 1)}><RefreshCw size={14} /> Check Product Manager again</button>}
                   {selectedJob.status === 'archived' && destinationProduct && (applyConfirmation?.jobId === selectedJob.id ? (
                    <div className="ipc-intent-note ipc-apply-confirmation" role="alertdialog" aria-label="Confirm Product Manager image replacement">
                      <AlertTriangle size={15} />
                      <div>
                        <strong>Confirm and apply to Product Manager.</strong>
                        <span>SKU {destinationProduct.sku} Â· {destinationProduct.title || 'Untitled product'} Â· {selectedSlot.label}</span>
                        <span>{currentDestinationImage ? 'The current Product Manager image will be replaced only after confirmation.' : 'This selected Product Manager position is empty; the archive asset will be added only after confirmation.'}</span>
                        <div className="ipc-comparison ipc-apply-comparison" aria-label={`Current and proposed ${selectedSlot.label} comparison`}>
                          <PreviewPane label={`Current Product Manager ${selectedSlot.label}`} url={currentDestinationImage} emptyText="This Product Manager position is empty" />
                          <PreviewPane label="Proposed archive asset" url={selectedJob.afterUrl} emptyText="Website-ready archive preview unavailable" websiteReady />
                        </div>
                      </div>
                      <button type="button" className="adm-btn-red adm-btn--sm" disabled={Boolean(busy)} onClick={() => void confirmProductManagerApply(selectedJob)}>Confirm and apply to Product Manager</button>
                      <button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy)} onClick={() => setApplyConfirmation(null)}>Cancel</button>
                    </div>
                   ) : <div className="ipc-intent-note"><ArrowRight size={15} /><span><strong>Archive asset is ready for a deliberate live application.</strong> Compare it with the chosen Product Manager position first; this remains a separate action from processing and approval.</span><button type="button" className="adm-btn-ghost adm-btn--sm" disabled={Boolean(busy)} onClick={() => requestProductManagerApply(selectedJob)}>Apply to Product Manager</button></div>)}
                  {selectedJob.status === 'published' && <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void runAction(selectedJob, 'restore')}><RotateCcw size={14} /> Restore original</button>}
                </div>
              )}
              {(ARCHIVED_STATUSES.has(selectedJob.status) || selectedJob.status === 'published' || selectedJob.status === 'restored') && (
                <div className="ipc-publish-box ipc-archive-adjustments" aria-label="Create adjusted archive revision">
                  <div className="ipc-destination-copy">
                    <span className="ipc-destination-eyebrow"><RotateCcw size={12} /> Create adjusted revision</span>
                    <strong>Adjust the archived website version without uploading again</strong>
                    <span>This makes a new review item from the retained transparent master. The current archive version stays intact and nothing is sent to Product Manager.</span>
                  </div>
                  <label>White canvas padding
                    <select value={(revisionAdjustments[selectedJob.id]?.paddingRatio ?? 0.08)} onChange={(event) => setRevisionAdjustments((current) => ({ ...current, [selectedJob.id]: { ...(current[selectedJob.id] || {}), paddingRatio: Number(event.target.value), background: '#FFFFFF' } }))} disabled={Boolean(busy)}>
                      <option value={0.04}>Tight Â· 4%</option><option value={0.08}>Standard Â· 8%</option><option value={0.12}>Relaxed Â· 12%</option><option value={0.16}>Wide Â· 16%</option>
                    </select>
                  </label>
                  <label>Background
                    <select value="#FFFFFF" disabled><option value="#FFFFFF">Pure white Â· #FFFFFF</option></select>
                  </label>
                  <label>Shadow
                    <select value={(revisionAdjustments[selectedJob.id]?.shadow ?? 'none')} onChange={(event) => setRevisionAdjustments((current) => ({ ...current, [selectedJob.id]: { ...(current[selectedJob.id] || {}), shadow: event.target.value, background: '#FFFFFF' } }))} disabled={Boolean(busy)}>
                      <option value="none">None</option><option value="soft">Soft natural shadow</option>
                    </select>
                  </label>
                  <button type="button" className="adm-btn-ghost" disabled={Boolean(busy)} onClick={() => void createArchiveRevision(selectedJob)}><RotateCcw size={14} /> Create new archive revision</button>
                </div>
              )}
              {selectedJob.status === 'restored' && <div className="ipc-publish-box"><div><strong>Original restored</strong><span>The processed version remains in the private archive and can be adjusted again later. No new live action is available from this workspace.</span></div></div>}
            </>
          ) : <div className="ipc-review-empty"><Sparkles size={28} /><strong>Select an image to review</strong><span>Before and after previews, quality checks and controlled publishing will appear here.</span></div>}
        </div>
      </div>
    </section>
  );
}

