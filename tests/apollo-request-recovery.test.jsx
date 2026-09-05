// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesPanel from '../src/components/HermesPanel.jsx';
import { askApolloOperations, waitForApolloJob } from '../src/lib/apolloOperations.js';

let root, container;
const response = (body) => new Response(JSON.stringify(body), { status: 200 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.location.href = 'https://protoportal-admin-example-proto-team.vercel.app/?section=hermes';
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const button = (text) => [...container.querySelectorAll('button')].find((item) => item.textContent.includes(text));

describe('Apollo request recovery', () => {
  it('shows the queue, stops waiting, preserves the question and resumes without another POST', async () => {
    const fetch = vi.fn(async (url, options) => options?.method === 'POST'
      ? response({ id: 'test-job', status: 'queued' })
      : response({ status: 'completed', result: { summary: 'Verified synthetic answer', findings: [] } }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('What are customers viewing?').click());
    expect(container.textContent).toContain('Waiting for the analysis worker');
    expect(button('Morning brief').disabled).toBe(true);
    await act(async () => button('Stop waiting').click());
    expect(container.textContent).toContain('Waiting stopped');
    expect(container.querySelector('input').value).toContain('customers viewing');
    expect(container.querySelector('input').disabled).toBe(false);
    await act(async () => button('Check this request again').click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain('Verified synthetic answer');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('ignores a late response after stopping even when the transport ignores cancellation', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
    await act(async () => button('Are systems healthy?').click());
    await act(async () => button('Stop waiting').click());
    await act(async () => finish(response({ checks: [{ state: 'healthy', label: 'Old answer', summary: 'stale' }] })));
    expect(container.textContent).toContain('Waiting stopped');
    expect(container.querySelector('[data-testid="apollo-operations-answer"]')).toBeNull();
  });
  it('does not misreport missing health or image evidence as healthy or empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({})));
    await expect(askApolloOperations('Are systems healthy?')).rejects.toThrow('cannot confirm');
    await expect(askApolloOperations('Show image processing')).rejects.toThrow('cannot confirm');
    vi.stubGlobal('fetch', vi.fn(async () => response({ jobs: [] })));
    await expect(askApolloOperations('Show image processing')).resolves.toMatchObject({ summary: '0 recent image items checked. 0 waiting in the workflow and 0 failed.' });
  });
  it('does not poll after an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(waitForApolloJob('test-job', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects completed jobs without an actual answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'completed', result: {} })));
    const pending = expect(waitForApolloJob('test-job')).rejects.toThrow('incomplete report');
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
  });
});
