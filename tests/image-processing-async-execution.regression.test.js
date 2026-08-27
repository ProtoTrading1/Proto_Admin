// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageProcessingCentre from '../src/components/productLoader/ImageProcessingCentre.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;

const mocks = vi.hoisted(() => ({
  currentJob: null,
  claimImageObject: vi.fn(),
  createPrivateSourceUrl: vi.fn(),
  releaseImageObjectClaim: vi.fn(),
  processImageWithFal: vi.fn(),
  persistJob: vi.fn(),
  assertReviewAssetsAvailable: vi.fn(),
}));

vi.mock('../api/_admin-auth.js', () => ({
  hasAdminKey: vi.fn(() => true),
  requireOwner: vi.fn(async () => true),
  verifyAdminUser: vi.fn(async () => ({ email: 'george@proto.co.za' })),
}));

vi.mock('../api/_image-processing-store.js', () => ({
  claimImageObject: mocks.claimImageObject,
  createPrivateSourceUrl: mocks.createPrivateSourceUrl,
  readImageJob: vi.fn(async () => mocks.currentJob),
  readImageJobIndex: vi.fn(async () => []),
  releaseImageObjectClaim: mocks.releaseImageObjectClaim,
}));

vi.mock('../api/_image-processing-service.js', () => ({
  estimatedImageCostUsd: vi.fn(() => 0.018),
  assertReviewAssetsAvailable: mocks.assertReviewAssetsAvailable,
  ingestLocalSource: vi.fn(),
  ingestStagedSource: vi.fn(),
  markImageApproved: vi.fn(),
  persistJob: mocks.persistJob,
  processImageWithFal: mocks.processImageWithFal,
  publishApprovedImage: vi.fn(),
  rejectImage: vi.fn(),
  restorePublishedOriginal: vi.fn(),
  targetedRepairAssetId: vi.fn(() => 'asset-test'),
}));

import handler from '../api/image-processing-jobs.js';

function imageJob(status = 'queued') {
  return {
    id: 'manifest-1',
    version: 0,
    status,
    createdAt: '2026-08-07T12:00:00.000Z',
    images: [{
      id: 'image-1',
      sku: 'ABC1',
      slot: 1,
      targetTable: 'website_stock',
      status,
      source: { type: 'local_upload', filename: 'ABC1.png', privatePath: 'image-processing/sources/manifest-1/image-1.png' },
      outputStoragePath: status === 'review' ? 'image-processing/sources/manifest-1/image-1-review.jpg' : null,
      processing: status === 'processing' ? { provider: 'fal.ai', claimId: 'start-claim' } : null,
    }],
  };
}

function request(action) {
  return {
    method: 'PATCH',
    query: { id: 'manifest-1~image-1' },
    headers: {},
    body: { action },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

describe('Image Processing Centre asynchronous fal execution contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentJob = imageJob('queued');
    mocks.claimImageObject.mockResolvedValue({ id: 'claim-1' });
    mocks.releaseImageObjectClaim.mockResolvedValue(true);
    mocks.createPrivateSourceUrl.mockResolvedValue('/signed/ABC1.png');
    mocks.assertReviewAssetsAvailable.mockResolvedValue(undefined);
    mocks.persistJob.mockImplementation(async (job) => {
      mocks.currentJob = structuredClone(job);
      return mocks.currentJob;
    });
    mocks.processImageWithFal.mockImplementation(async (_job, image) => ({
      ...image,
      status: 'review',
      reviewUrl: '/processed/ABC1.png',
      outputStoragePath: 'image-processing/sources/manifest-1/image-1-review.jpg',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('makes action=process a quick state transition without invoking the paid provider', async () => {
    const res = response();
    await handler(request('process'), res);

    expect.soft([200, 202]).toContain(res.statusCode);
    expect.soft(res.body?.job?.status).toBe('processing');
    expect.soft(mocks.persistJob).toHaveBeenCalledTimes(1);
    expect.soft(mocks.processImageWithFal).not.toHaveBeenCalled();
  });

  it('accepts action=execute and claim-protects concurrent requests so fal runs once', async () => {
    mocks.currentJob = imageJob('processing');
    mocks.claimImageObject
      .mockResolvedValueOnce({ id: 'claim-1' })
      .mockResolvedValueOnce(null);

    mocks.processImageWithFal.mockImplementation(async (_job, image) => ({
      ...image,
      status: 'review',
      reviewUrl: '/processed/ABC1.png',
      outputStoragePath: 'image-processing/sources/manifest-1/image-1-review.jpg',
    }));

    const firstRes = response();
    const secondRes = response();
    const first = handler(request('execute'), firstRes);
    const second = handler(request('execute'), secondRes);
    await Promise.all([first, second]);

    expect.soft(mocks.processImageWithFal).toHaveBeenCalledTimes(1);
    expect.soft(firstRes.statusCode).toBe(200);
    expect.soft(firstRes.body?.job).toMatchObject({ status: 'review', after_url: '/signed/ABC1.png' });
    expect.soft([202, 409]).toContain(secondRes.statusCode);
    expect.soft(mocks.releaseImageObjectClaim).toHaveBeenCalled();
  });

  it('downgrades a review item to retryable failure when either preview cannot be signed', async () => {
    mocks.currentJob = imageJob('review');
    mocks.createPrivateSourceUrl
      .mockResolvedValueOnce('/signed/original.png')
      .mockRejectedValueOnce(new Error('storage object missing'));
    const res = response();

    await handler({ method: 'GET', query: { id: 'manifest-1~image-1' }, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.jobs[0]).toMatchObject({
      status: 'failed',
      before_url: '',
      after_url: '',
      error: 'The website-ready review asset is unavailable.',
    });
    expect(res.body.jobs[0].quality_flags).toContain('review_assets_unavailable');
  });

  it('rejects approval when the retained review assets can no longer be signed', async () => {
    mocks.currentJob = imageJob('review');
    mocks.assertReviewAssetsAvailable.mockRejectedValue(Object.assign(
      new Error('The retained original or website-ready review asset is unavailable. Reprocess this image before approval.'),
      { code: 'ipc_review_assets_unavailable' },
    ));
    const res = response();

    await handler(request('approve'), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/unavailable/i);
    expect(mocks.persistJob).not.toHaveBeenCalled();
  });

  it('safely adopts a legacy processing job only after the old inline request cannot still be running', async () => {
    mocks.currentJob = imageJob('processing');
    mocks.currentJob.images[0].processing = {
      provider: 'fal.ai',
      startedAt: new Date(Date.now() - (7 * 60_000)).toISOString(),
    };
    mocks.claimImageObject
      .mockResolvedValueOnce({ id: 'legacy-recovery-claim', expiresAt: new Date(Date.now() + 900_000).toISOString() })
      .mockResolvedValueOnce({ id: 'legacy-run-claim', expiresAt: new Date(Date.now() + 900_000).toISOString() });

    const res = response();
    await handler(request('execute'), res);

    expect.soft(res.statusCode).toBe(200);
    expect.soft(res.body?.job).toMatchObject({ status: 'review', after_url: '/signed/ABC1.png' });
    expect.soft(mocks.processImageWithFal).toHaveBeenCalledTimes(1);
    expect.soft(mocks.persistJob.mock.calls.some(([saved]) => (
      saved.images[0].processing?.claimId === 'legacy-recovery-claim'
      && saved.images[0].processing?.state === 'awaiting_dispatch'
    ))).toBe(true);
  });

  it('explicitly resumes a recovered job once, polls processing state, and displays the After image when fal finishes', async () => {
    vi.useFakeTimers();
    let state = {
      id: 'job-async', filename: 'ABC1.png', sku: 'ABC1', status: 'queued',
      before_url: '/original/ABC1.png', after_url: '',
    };
    let executeCalls = 0;
    let executeAborted = false;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options = {}) => {
      if (!options.method || options.method === 'GET') return Promise.resolve(jsonResponse({ jobs: [state] }));
      const action = JSON.parse(options.body).action;
      if (action === 'process') {
        state = { ...state, status: 'processing' };
        return Promise.resolve(jsonResponse({ job: state }, 202));
      }
      if (action === 'execute') {
        executeCalls += 1;
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            executeAborted = true;
            reject(new globalThis.DOMException('Aborted', 'AbortError'));
          }, { once: true });
          setTimeout(() => {
            state = { ...state, status: 'review', after_url: '/processed/ABC1.png' };
            resolve(jsonResponse({ job: state }));
          }, 20_000);
        });
      }
      throw new Error(`Unexpected image action: ${action}`);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ImageProcessingCentre));
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const startButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Start processing'));
      expect(startButton).toBeTruthy();
      await act(async () => {
        startButton.click();
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(executeCalls).toBe(1);
      expect(executeAborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(container.querySelector('img[alt="Website-ready white 1600 Ã— 1600 product"]')?.getAttribute('src')).toBe('/processed/ABC1.png');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_000);
      });
      expect(executeCalls).toBe(1);
      expect(fetchMock.mock.calls.filter(([, options = {}]) => !options.method || options.method === 'GET').length).toBeGreaterThan(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps a newly uploaded image when an older queue refresh finishes afterward', async () => {
    let resolveInitialQueue;
    const initialQueue = new Promise((resolve) => { resolveInitialQueue = resolve; });
    const uploaded = {
      id: 'manifest-new~image-new',
      filename: 'NEW-PHOTO.png',
      sku: 'NEW-PHOTO',
      status: 'review',
      before_url: '/original/NEW-PHOTO.png',
      after_url: '/processed/NEW-PHOTO.png',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options = {}) => {
      if (!options.method || options.method === 'GET') return initialQueue;
      if (options.method === 'POST') return Promise.resolve(jsonResponse({ jobs: [uploaded] }, 201));
      throw new Error(`Unexpected request method: ${options.method}`);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ImageProcessingCentre));
        await Promise.resolve();
      });
      await act(async () => {
        container.querySelector('input[name="image-processing-preset"][value="standard_opaque"]').click();
        await Promise.resolve();
      });

      const imageInput = container.querySelectorAll('.ipc-file-input')[1];
      const file = {
        name: 'NEW-PHOTO.png',
        type: 'image/png',
        size: 4,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
      };
      Object.defineProperty(imageInput, 'files', { configurable: true, value: [file] });
      await act(async () => {
        imageInput.dispatchEvent(new window.Event('change', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain('NEW-PHOTO.png');
      });

      await act(async () => {
        resolveInitialQueue(jsonResponse({ jobs: [] }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('NEW-PHOTO.png');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each([
    { before_url: '', after_url: '/processed/8610700004-50pcs.JPG' },
    { before_url: '/original/8610700004-50pcs.JPG', after_url: '' },
  ])('blocks approval and clearly reports an incomplete review when a required preview is missing', async ({ before_url, after_url }) => {
    const incompleteReview = {
      id: 'job-incomplete', filename: '8610700004-50pcs.JPG', sku: '8610700004',
      status: 'review', quality_score: 100, quality_flags: [],
      before_url, after_url,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options = {}) => {
      if (!options.method || options.method === 'GET') return Promise.resolve(jsonResponse({ jobs: [incompleteReview] }));
      throw new Error(`Unexpected image request: ${options.method}`);
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ImageProcessingCentre));
        await Promise.resolve();
        await Promise.resolve();
      });

      const reviewCheckbox = container.querySelector('.ipc-review-checklist-primary input');
      await act(async () => {
        reviewCheckbox.click();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Review incomplete: the retained original or website-ready preview is unavailable. Approval is blocked.');
      const approveButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Approve result'));
      expect(approveButton).toBeTruthy();
      expect(approveButton.disabled).toBe(true);

      await act(async () => {
        approveButton.click();
        await Promise.resolve();
      });
      expect(fetchMock.mock.calls.some(([, options = {}]) => (
        options.method === 'PATCH' && JSON.parse(options.body).action === 'approve'
      ))).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

