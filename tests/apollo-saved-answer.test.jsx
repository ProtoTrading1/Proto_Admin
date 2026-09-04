// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesPanel from '../src/components/HermesPanel.jsx';
import { readSavedApolloAnswer, rememberApolloReference, savedApolloReference } from '../src/lib/apolloOperations.js';

const jobId = 'e8d5dac1-ce27-4f14-8bf8-2c3b3b460f07';
const base = 'https://protoportal-admin-example-proto-team.vercel.app/';
const result = { summary: 'Synthetic saved attention report', findings: [], limitations: ['Synthetic data only.'] };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
let root, container;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.location.href = `${base}?section=hermes&apolloJob=${jobId}`;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const button = (label) => [...container.querySelectorAll('button')].find((item) => item.textContent.includes(label));

describe('Saved Apollo answer recovery', () => {
  it('opens the exact completed job with one GET and no new analysis', async () => {
    const fetch = vi.fn(async () => response({ id: jobId, status: 'completed', result }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button('View saved answer').click());
    expect(container.textContent).toContain(result.summary);
    expect(container.textContent).toContain('Synthetic data only.');
    expect(container.textContent).toContain('Preview mode');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`/api/codex-analytics-jobs?id=${jobId}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
    expect(container.querySelector(`a[href="?section=hermes&apolloJob=${jobId}"]`)).not.toBeNull();
  });
  it('retains the queued job across an unmount and reopens without a second POST', async () => {
    window.location.href = `${base}?section=hermes`;
    const fetch = vi.fn(async (url, options) => options?.method === 'POST'
      ? response({ id: jobId, status: 'queued' })
      : response({ id: jobId, status: 'completed', result }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('What are customers viewing?').click());
    expect(savedApolloReference(window.location.search)).toBe(jobId);
    expect(window.location.search).not.toContain('customers');
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('View saved answer').click());
    expect(container.textContent).toContain(result.summary);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it.each([401, 403, 404, 500])('never falls back to a new job when retrieval returns %i', async (status) => {
    const fetch = vi.fn(async () => response({ error: 'Saved answer unavailable' }, status));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('View saved answer').click());
    expect(container.textContent).toContain('Saved answer unavailable');
    expect(button('View saved answer')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });
  it('retains a timed-out request for a later saved-answer check', async () => {
    const fetch = vi.fn(async () => response({ id: jobId, status: 'queued' }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('View saved answer').click());
    await act(async () => vi.advanceTimersByTimeAsync(250000));
    expect(container.textContent).toContain('has not returned an answer yet');
    fetch.mockImplementation(async () => response({ id: jobId, status: 'completed', result }));
    await act(async () => button('View saved answer').click());
    expect(container.textContent).toContain(result.summary);
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('ignores a late saved answer after stopping and does not start duplicate requests', async () => {
    let finish;
    const fetch = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    const open = button('View saved answer');
    await act(async () => { open.click(); open.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => button('Stop waiting').click());
    await act(async () => finish(response({ id: jobId, status: 'completed', result })));
    expect(container.textContent).not.toContain(result.summary);
    expect(button('View saved answer')).toBeDefined();
  });
  it('rejects an invalid reference without making any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(savedApolloReference('?apolloJob=invalid')).toBeNull();
    await expect(readSavedApolloAnswer('../bad')).rejects.toThrow('invalid');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps unrelated URL parameters and tolerates unavailable history', () => {
    window.location.href = `${base}?section=hermes&keep=yes#admin-main`;
    expect(rememberApolloReference(jobId)).toBe(true);
    expect(window.location.search).toContain('keep=yes');
    expect(window.location.hash).toBe('#admin-main');
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('Blocked'); });
    expect(rememberApolloReference(jobId)).toBe(false);
  });
  it('does not label a fresh health answer with an older analytics link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ checks: [{ state: 'healthy', label: 'Test', summary: 'OK' }] })));
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('Are systems healthy?').click());
    expect(container.querySelector('a[href*="apolloJob"]')).toBeNull();
  });
});
