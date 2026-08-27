import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNutstoreImageJobs,
  createUploadedImageJobs,
  clearImageProcessingJob,
  executeImageProcessingJob,
  fetchImageProcessingJobs,
  multiSkuMappingsFromFilename,
  normalizeImageProcessingJob,
  summarizeImageProcessingJobs,
  updateImageProcessingJob,
} from '../src/lib/imageProcessingJobs.js';

const panelSource = fs.readFileSync(new URL('../src/components/ProductLoaderPanel.jsx', import.meta.url), 'utf8');
const nutstoreSource = fs.readFileSync(new URL('../src/components/productLoader/ProductLoaderNutstore.jsx', import.meta.url), 'utf8');
const uploadSource = fs.readFileSync(new URL('../src/components/productLoader/ProductLoaderUpload.jsx', import.meta.url), 'utf8');
const adminSource = fs.readFileSync(new URL('../src/pages/AdminPage.jsx', import.meta.url), 'utf8');
const sidebarSource = fs.readFileSync(new URL('../src/components/GroupedSidebar.jsx', import.meta.url), 'utf8');
const centreSource = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
const stylesheetSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Image Processing Centre API adapter', () => {
  it('keeps one paid processing item while retaining every exact SKU candidate', async () => {
    expect(multiSkuMappingsFromFilename('8610100002 8610100003 & 8610100004.8610100005.jpg'))
      .toEqual(['8610100002', '8610100003', '8610100004', '8610100005']);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: [] }));
    await createNutstoreImageJobs([{
      path: '/PTR-photos/8610100002 8610100003.jpg',
      filename: '8610100002 8610100003.jpg',
    }], { style: 'measurements', instructions: 'Preserve every label' });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      sku: '8610100002',
      skuCandidates: ['8610100002', '8610100003'],
      style: 'measurements',
      instructions: 'Preserve every label',
    });
  });

  it('normalizes worker response variants for a stable review UI', () => {
    expect(normalizeImageProcessingJob({
      job_id: 42,
      product_code: 'ABC1',
      source_image: { name: 'ABC1.jpg', url: '/before.jpg', source: 'nutstore' },
      processed_image: { preview_url: '/after.png' },
      quality_report: { score: 91, flags: ['edge_halo'] },
      cost: { zar: 0.18 },
    })).toMatchObject({
      id: '42', sku: 'ABC1', filename: 'ABC1.jpg', beforeUrl: '/before.jpg',
      afterUrl: '/after.png', qualityScore: 91, qualityFlags: ['edge_halo'], estimatedCost: 0.18,
    });
  });

  it('retains the immutable displayed asset id required by targeted repair', () => {
    expect(normalizeImageProcessingJob({
      id: 'repairable',
      status: 'review',
      displayed_asset_id: 'ipc_asset_123',
    })).toMatchObject({ displayedAssetId: 'ipc_asset_123' });
  });

  it('creates Nutstore batches through the flat collection endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: [{ id: 'j1', status: 'queued' }] }));
    await createNutstoreImageJobs([{ path: '/PTR-photos/ABC1.jpg', filename: 'ABC1.jpg' }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/image-processing-jobs', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      source: 'nutstore',
      items: [{ path: '/PTR-photos/ABC1.jpg', filename: 'ABC1.jpg' }],
    });
  });

  it('uses a query id for the explicit archive action', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ job: { id: 'job/7', status: 'archived' } }));
    await updateImageProcessingJob('job/7', 'archive');
    expect(fetchMock).toHaveBeenCalledWith('/api/image-processing-jobs?id=job%2F7', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'archive' }),
    }));
  });

  it('clears an unpublished image through an explicit queue action', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ removed: 'job-7~image-2' }));
    await expect(clearImageProcessingJob('job-7~image-2')).resolves.toBe('job-7~image-2');
    expect(fetchMock).toHaveBeenCalledWith('/api/image-processing-jobs?id=job-7~image-2', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'clear' }),
    }));
  });

  it('summarizes queue state and estimated Rand cost', () => {
    expect(summarizeImageProcessingJobs([
      { status: 'processing', estimatedCost: 0.12 },
      { status: 'ready', estimatedCost: 0.18 },
      { status: 'archived', estimatedCost: 0.2 },
      { status: 'failed', estimatedCost: 0 },
    ])).toEqual({ total: 4, processing: 1, review: 1, approved: 1, failed: 1, cost: 0.5 });
  });
});
describe('Product Loader handoff and owner visibility', () => {
  it('keeps the centre owner-only and separate from Product Loader tabs', () => {
    expect(panelSource).toContain("initialTab === 'image-processing' && isOwner");
    expect(panelSource).toContain('onOpenImageProcessing?.({ nutstoreSelection: selection');
    expect(panelSource).not.toContain("...(isOwner ? [{ id: 'image-processing'");
    expect(adminSource).toContain("isOwner={customer?.role === 'owner'}");
  });

  it('exposes the workflow map and accessible queue relationships', () => {
    expect(centreSource).toContain('aria-label="Image processing workflow"');
    expect(centreSource).toContain('Choose treatment');
    expect(centreSource).toContain('Review result');
    expect(centreSource).toContain('Archive or apply');
    expect(centreSource).toContain('aria-controls="ipc-queue-panel"');
    expect(centreSource).toContain('role="tabpanel"');
    expect(centreSource).toContain('aria-describedby="ipc-instructions-help"');
    expect(centreSource).toContain('Open Nutstore');
    expect(centreSource).toContain('onOpenNutstore');
  });

  it('offers a separate discard action for approved staged images', () => {
    expect(centreSource).toContain("'approved', 'failed'");
    expect(centreSource).toContain('Discard staged image');
    expect(centreSource).toContain('discards the approved staged result');
  });

  it('turns a stalled queue request into a retryable error', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new globalThis.DOMException('Aborted', 'AbortError')));
    }));
    const pending = fetchImageProcessingJobs();
    const assertion = expect(pending).rejects.toThrow('The image queue did not respond. Please retry.');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    vi.useRealTimers();
  });

  it('does not abort a legitimate paid execution at the generic 15-second queue timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new globalThis.DOMException('Aborted', 'AbortError'));
      }, { once: true });
      setTimeout(() => resolve(jsonResponse({
        job: { id: 'job-async', status: 'review', after_url: '/processed/job-async.png' },
      })), 20_000);
    }));

    const execution = executeImageProcessingJob('job-async')
      .then((job) => ({ job }), (error) => ({ error }));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({
      job: { id: 'job-async', status: 'review', afterUrl: '/processed/job-async.png' },
    });
    vi.useRealTimers();
  });

  it('queues local uploads through the JSON API path used by Vercel functions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jobs: [{ id: 'j-upload', status: 'queued' }] }));
    const file = {
      name: 'DISPOSABLE.png', type: 'image/png', size: 4,
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    };
    await createUploadedImageJobs([file]);
    expect(fetchMock).toHaveBeenCalledWith('/api/image-processing-jobs', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      source: 'upload',
      items: [{ filename: 'DISPOSABLE.png', contentType: 'image/png', base64: 'iVBORw==' }],
    });
  });

  it('offers one reviewed image destination and a title-only replacement screen', () => {
    expect(sidebarSource).toContain("{ id: 'image-processing', label: 'Image Processing Centre'");
    expect(sidebarSource).not.toContain("{ id: 'image-replace'");
    expect(sidebarSource).toContain("{ id: 'title-replace', label: 'Title Replace'");
    expect(adminSource).toContain("activeSection === 'image-processing'");
    expect(adminSource).toContain('initialTab="image-processing"');
    expect(adminSource).toContain('<BulkImageReplacePanel');
    expect(adminSource).toContain('titleOnly');
  });

  it('hands off selected Nutstore paths and selected upload files', () => {
    expect(nutstoreSource).toContain('onProcessSelected(selectedPaths.map');
    expect(nutstoreSource).toContain('Improve selected');
    expect(uploadSource).toContain('onProcessFiles(sourceFiles)');
    expect(uploadSource).toContain('Improve selected');
    expect(adminSource).toContain('nutstoreSelection: loadPendingNutstoreHandoff()');
    expect(adminSource).toContain('savePendingNutstoreHandoff(');
    expect(adminSource).toContain("window.addEventListener('storage', syncPendingNutstoreHandoff)");
    expect(adminSource).toContain('onNutstoreSelectionConsumed={consumeNutstoreHandoff}');
    expect(adminSource).toContain('intakeOptions={imageProcessingIntake}');
    expect(adminSource).toContain('onIntakeOptionsChange={rememberImageProcessingIntake}');
    expect(centreSource).toContain("useState(() => intakeOptions?.treatment || 'standard_opaque')");
    expect(centreSource).toContain('rememberIntakeChange({ treatment: preset.id, instructions: customInstructions })');
    expect(centreSource).toContain('rememberIntakeChange({ treatment: processingPreset, instructions })');
  });

  it('shows large, uncropped Nutstore source thumbnails for visual selection', () => {
    expect(stylesheetSource).toContain('.pl-nutstore-thumb-slot { flex-shrink: 0; width: 88px; height: 88px;');
    expect(stylesheetSource).toContain('.pl-nutstore-thumb { width: 88px; height: 88px; object-fit: contain;');
  });

  it('keeps review, explicit archive, and separate live application as deliberate steps', () => {
    expect(panelSource).toContain('<ImageProcessingCentre');
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain("runAction(selectedJob, 'approve',");
    expect(centre).toContain("runAction(selectedJob, 'archive')");
    expect(centre).toContain("runAction(job, 'apply'");
    expect(centre).toContain('Save approved result to Image Archive');
    expect(centre).toContain('Confirm and apply to Product Manager');
    expect(centre).not.toContain("runAction(job, 'publish'");
    expect(centre).toContain("runBulkReviewAction('archive')");
    expect(centre).toContain("runAction(selectedJob, 'approve',");
    expect(centre).not.toContain("updateImageProcessingJob(job.id, 'approve')");
    expect(centre).toContain("runAction(selectedJob, 'archive')");
    expect(centre).toContain("runAction(selectedJob, 'restore')");
    expect(centre).toContain('Clear from queue');
    expect(centre).toContain('manual human review');
    expect(centre).toContain('Targeted background repair');
    expect(centre).not.toContain("id: 'targeted_reconstruction'");
    expect(centre).toContain('History & archive');
  });

  it('returns signed original and website-ready preview URLs immediately after a mutation', () => {
    const jobsRoute = fs.readFileSync(new URL('../api/image-processing-jobs.js', import.meta.url), 'utf8');
    expect(jobsRoute).toContain('const [publicUpdated] = await publicJobItemsWithSource(saved, [saved.images[runningIndex]])');
    expect(jobsRoute).toContain('const [publicUpdated] = await publicJobItemsWithSource(saved, [saved.images[index]])');
  });

  it('refreshes signed preview URLs when an image expires or fails to load', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('refreshExpiredPreview');
    expect(centre).toContain('onError={onImageError}');
    expect(centre).toContain('loadJobs({ quiet: true })');
  });

  it('requires a complete human checklist and treatment acknowledgement before approval', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('correctSku: selectedReviewChecklist.correctSku === true');
    expect(centre).toContain('labelsPreserved: selectedReviewChecklist.labelsPreserved === true');
    expect(centre).toContain('cleanEdgesBackground: selectedReviewChecklist.cleanEdgesBackground === true');
    expect(centre).toContain('treatmentVerified: selectedReviewChecklist.treatmentVerified === true');
    expect(centre).toContain("reviewChecklistComplete");
    expect(centre).toContain("action === 'retry'");
    expect(centre).toContain('Treatment-specific verification');
  });

  it('never duplicates a multi-SKU source for another paid provider run and gates sensitive cutouts', () => {
    const adapter = fs.readFileSync(new URL('../src/lib/imageProcessingJobs.js', import.meta.url), 'utf8');
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(adapter).not.toContain('flatMap((item)');
    expect(adapter).toContain('skuCandidates');
    expect(centre).toContain('Processing is charged once');
    expect(centre).toContain('manualSafeCutout');
    expect(centre).toContain('I inspected these source images and confirm an automatic cutout is safe.');
    expect(centre).toContain('This is a source-preserving/manual lane.');
    expect(centre).toContain('!intakeCanStart');
  });

  it('blocks generic clean-up when sticker or printed-label preservation is requested', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('PRESERVATION_CONTENT_HINT');
    expect(centre).toContain('genericTreatmentWithPreservationContent');
    expect(centre).toContain('Sticker/label preservation requires a protected treatment.');
    expect(centre).toContain('Generic clean-up is blocked');
  });

  it('draws targeted repairs against the exact rendered processed asset and creates a new review revision', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('event.currentTarget.getBoundingClientRect()');
    expect(centre).toContain('displayRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }');
    expect(centre).toContain("runAction(job, 'targeted_repair'");
    expect(centre).toContain('displayedAssetId: repairDraft.displayedAssetId');
    expect(centre).toContain('repairAreaRatio <= 0.35');
    expect(centre).toContain("setSelectedJobId(updated.id)");
    expect(centre).toContain('one additional fal.ai provider charge');
    expect(centre).toContain('does not change Product Manager or the website');
    expect(centre).toContain("REVIEW_STATUSES.has(selectedJob.status) && selectedJob.afterUrl && selectedJob.displayedAssetId");
  });

  it('uses Product Manager only as a separately confirmed destination for an archived asset', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('Image Archive');
    expect(centre).toContain('Apply to Product Manager');
    expect(centre).toContain('Main product image');
    expect(centre).toContain('Gallery image 2');
    expect(centre).toContain("normalizedSku(product.sku) !== sku");
    expect(centre).toContain('No exact Product Manager product matches SKU');
    expect(centre).toContain('The current Product Manager image will be replaced only after confirmation.');
  });

  it('shows an accessible old-versus-new comparison inside the final Product Manager apply confirmation', () => {
    const centre = fs.readFileSync(new URL('../src/components/productLoader/ImageProcessingCentre.jsx', import.meta.url), 'utf8');
    expect(centre).toContain('Confirm Product Manager image replacement');
    expect(centre).toContain('Current Product Manager ${selectedSlot.label}');
    expect(centre).toContain('Proposed archive asset');
    expect(centre).toContain('SKU {destinationProduct.sku} Â· {destinationProduct.title || \'Untitled product\'} Â· {selectedSlot.label}');
    expect(centre).toContain('url={currentDestinationImage}');
    expect(centre).toContain('url={selectedJob.afterUrl}');
  });
});

