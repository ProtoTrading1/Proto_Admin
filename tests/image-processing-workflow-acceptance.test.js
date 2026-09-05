import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
}

const centreSource = readSource('../src/components/productLoader/ImageProcessingCentre.jsx');
const jobsAdapterSource = readSource('../src/lib/imageProcessingJobs.js');
const jobsRouteSource = readSource('../api/image-processing-jobs.js');
const serviceSource = readSource('../api/_image-processing-service.js');
const stylesheetSource = readSource('../src/index.css');

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `Could not find ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `Could not find ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Image Processing Centre owner-safety acceptance contract', () => {
  it('shows the complete square review asset without visually cropping its edges', () => {
    expect(stylesheetSource).toContain('.ipc-preview-image { display: grid; width: 100%; height: auto; aspect-ratio: 1 / 1;');
    expect(stylesheetSource).toContain('object-fit: contain; object-position: center;');
    expect(stylesheetSource).not.toContain('.ipc-preview-image { height: 210px; }');
  });

  it('opens both review images in an accessible full-size lightbox', () => {
    expect(centreSource).toContain('function ImageLightbox({ label, url, onClose })');
    expect(centreSource).toContain('role="dialog" aria-modal="true"');
    expect(centreSource).toContain('if (event.key === \'Escape\') onClose();');
    expect(centreSource).toContain('aria-label={`View ${label} full size`}');
    expect(centreSource).toContain('Click to enlarge');
    expect(stylesheetSource).toContain('.ipc-image-lightbox { position: fixed;');
    expect(stylesheetSource).toContain('.ipc-image-lightbox__content > img');
  });

  it('keeps a newly queued local upload visible when an earlier queue load returns late', () => {
    const loadJobs = sourceSection(centreSource, 'const loadJobs = useCallback', 'useEffect(() => { void loadJobs();');
    const queueUploads = sourceSection(centreSource, 'const queueUploads = async', 'const runAction = async');

    expect(loadJobs).toContain('const loadSequence = ++queueLoadSequenceRef.current');
    expect(loadJobs).toContain('const mutationVersion = queueMutationVersionRef.current');
    expect(loadJobs).toContain('loadSequence !== queueLoadSequenceRef.current');
    expect(loadJobs).toContain('mutationVersion !== queueMutationVersionRef.current');
    expect(loadJobs).toContain('setJobs((current) =>');
    expect(loadJobs).toContain('!rows.length && hasLocallyActiveJob && mutationIsRecent');
    expect(loadJobs).toContain('return rows;');
    expect(queueUploads).toContain('markQueueMutation();');
    expect(queueUploads).toContain('mergeJobs(created);');
  });

  it('does not automatically charge recovered queued jobs without a fresh operator click', () => {
    const executionEffect = sourceSection(centreSource, 'useEffect(() => {\n    if (busy || processInFlightRef.current)', 'const runBulkReviewAction = async');
    expect(executionEffect).toContain('executionAuthorizationRef.current.has(job.id)');
    expect(centreSource).toContain("selectedJob.status === 'queued' ? 'Start processing' : 'Resume processing'");
    expect(centreSource).toContain('Recovered safely. Processing will not start until you click the button.');
    expect(centreSource).toContain('authorizeExecution(created);');
  });

  it('does not turn the advisory quality summary into an invisible approval blocker', () => {
    expect(centreSource).toContain("qualityFlagCode(flag) !== 'quality_needs_attention'");
    expect(centreSource).toContain('detached_label|barcode');
    expect(centreSource).toContain('blockingQualityFlags.length > 0');
  });

  it('switches to the archive view after a successful archive action', () => {
    expect(centreSource).toContain("if (action === 'archive') {");
    expect(centreSource).toContain("setQueueView('archive');");
    expect(centreSource).toContain('setSelectedJobId(updated.id);');
  });

  it('returns the durable archive timestamp needed for new-versus-old grouping', () => {
    expect(jobsRouteSource).toContain("archived_at: image.archivedAt || image.archive?.destinationSnapshot?.capturedAt || ''");
  });

  it('records manual approval without publishing or changing Product Manager', () => {
    const approvalBranch = sourceSection(jobsRouteSource, "} else if (action === 'approve')", "} else if (action === 'assign_destination')");
    const approvalService = sourceSection(serviceSource, 'export function markImageApproved', 'export async function archiveApprovedImage');
    const approvalControl = sourceSection(centreSource, 'const approveSelectedJob = async', 'const assignCandidateSku = async');

    expect(approvalBranch).toContain('markImageApproved');
    expect(approvalBranch).not.toContain('publishApprovedImage');
    expect(approvalService).toContain("status: 'approved'");
    expect(approvalService).not.toContain('publishedUrl');
    expect(approvalService).not.toContain('publication:');
    expect(approvalControl).toContain("runAction(selectedJob, 'approve', {");
    expect(approvalControl).toContain('reviewChecklist: {');
    expect(centreSource).toContain('Approve result');
  });

  it('requires an exact Product Manager SKU before an archived asset can be applied', () => {
    const destinationLookup = sourceSection(centreSource, 'useEffect(() => {\n    const sku = normalizedSku(selectedJob?.destination?.sku || selectedJob?.sku);', 'const mergeJobs = useCallback');
    const applyControl = sourceSection(centreSource, 'const requestProductManagerApply =', 'const clearJob = async');

    expect(destinationLookup).toContain('/api/product-loader-lookup?code=${encodeURIComponent(sku)}');
    expect(destinationLookup).toContain('normalizedSku(product.sku) !== sku');
    expect(destinationLookup).toContain('No exact Product Manager product matches SKU');
    expect(applyControl).toContain('if (!job.archive?.assetId || !destinationProduct) return;');
    expect(centreSource).toContain("runAction(job, 'apply'");
    expect(centreSource).toContain('Confirm and apply to Product Manager');
  });

  it('lets an owner deliberately bind an unmatched filename to a verified Product Manager product before sending', () => {
    expect(centreSource).toContain('Find Product Manager product');
    expect(centreSource).toContain('Stage this Product Manager destination');
    expect(centreSource).toContain("runAction(job, 'assign_destination'");
    expect(jobsRouteSource).toContain("action === 'assign_destination'");
    expect(serviceSource).toContain('export async function assignImageDestination');
    expect(serviceSource).toContain("source: 'manual_selection'");
    expect(serviceSource).toContain("if (!['review', 'approved', 'archived'].includes(image.status))");
  });

  it('allows rejected and failed work to be cleared only through the explicit safe queue action', () => {
    const clearService = sourceSection(serviceSource, 'export async function clearUnpublishedImage', 'async function objectExists');
    const clearUi = sourceSection(centreSource, 'const clearJob = async', 'useEffect(() => {\n    if (busy || processInFlightRef.current)');

    expect(centreSource).toContain("const CLEARABLE_STATUSES = new Set(['review', 'ready', 'completed', 'approved', 'failed', 'error', 'rejected'])");
    expect(centreSource).toContain("['failed', 'error', 'rejected'].includes(selectedJob.status)");
    expect(clearUi).toContain('It does not change any product or Nutstore image.');
    expect(clearUi).toContain('await clearImageProcessingJob(job.id);');
    expect(jobsAdapterSource).toContain("body: JSON.stringify({ action: 'clear' })");
    expect(serviceSource).toContain("const CLEARABLE_IMAGE_STATUSES = new Set(['review', 'ready', 'completed', 'approved', 'failed', 'error', 'rejected'])");
    expect(clearService).toContain('Archived or published images cannot be cleared from this queue');
  });

  it('keeps restore as a separate action, available only after an explicit Product Manager send', () => {
    const restoreService = sourceSection(serviceSource, 'export async function restorePublishedOriginal', 'export async function rejectImage');

    expect(centreSource).toContain("selectedJob.status === 'published' && <button");
    expect(centreSource).toContain("runConfirmedQueueAction(selectedJob, 'restore')");
    expect(restoreService).toContain("image.status !== 'published'");
    expect(restoreService).toContain('Only a published processed image can be restored');
    expect(restoreService).toContain("publishMode: 'restore_original'");
  });

  it('uses the guarded apply path for the legacy apply_archived action and labels published assets accurately', () => {
    const actionDispatch = sourceSection(jobsRouteSource, 'const action = requestedAction', "return res.status(400).json({ error: 'Unsupported image processing action' });");

    expect(jobsRouteSource).toContain("const action = requestedAction === 'apply_archived' ? 'apply' : requestedAction;");
    expect(jobsRouteSource).toContain("} else if (action === 'apply') {");
    expect(actionDispatch).toContain("if (['process', 'execute', 'approve'");
    expect(actionDispatch).toContain("'archive', 'create_revision', 'apply', 'targeted_repair', 'reject'");
    expect(actionDispatch).toContain("'retry', 'restore', 'clear'].includes(action)");
    expect(centreSource).toContain("selectedJob.status === 'published'\n                      ? 'This website-ready white 1600 × 1600 version has already been applied to Product Manager.");
    expect(centreSource).toContain("'This website-ready white 1600 × 1600 version is staged only. It has not changed Product Manager or the live website.'");
  });
});
