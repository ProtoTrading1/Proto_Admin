import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCreatedJobId, waitForJob } from '../src/components/BackendAnalyticsAnalyst.jsx';

describe('Backend Analyst polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.window = {
      setTimeout,
      clearTimeout,
      localStorage: { removeItem: vi.fn() },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete globalThis.window;
  });

  it('returns a completed report and clears the resumable job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'completed', result: { summary: 'Ready' } }),
    })));
    const pending = waitForJob('job-1', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({ summary: 'Ready' });
    expect(window.localStorage.removeItem).toHaveBeenCalled();
  });

  it('stops immediately when the owning screen is unmounted', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const controller = new AbortController();
    const pending = waitForJob('job-2', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the useful read-only preview message', () => {
    expect(() => requireCreatedJobId(
      { ok: false, status: 409 },
      { error: 'This preview is read-only. Nothing was changed.' },
    )).toThrow('This preview is read-only. Nothing was changed.');
  });
});
