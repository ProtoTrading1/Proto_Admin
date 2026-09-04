// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesPanel from '../src/components/HermesPanel.jsx';

let root, container;
beforeEach(async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.location.href = 'https://protoportal-admin-example-proto-team.vercel.app/?section=hermes';
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<HermesPanel onSelectSection={() => {}} />));
  const input = container.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Are systems healthy?');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

describe('Apollo keyboard and duplicate-request acceptance', () => {
  it.each([{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }])('does not submit modified/IME Enter %j', async (options) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
    await act(async () => container.querySelector('input').dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('submits ordinary Enter once, then blocks a duplicate form event', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    await act(async () => {
      container.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Send question"]').disabled).toBe(true);
  });
  it('aborts its transport when leaving the panel', async () => {
    const fetch = vi.fn(() => new Promise(() => {})); vi.stubGlobal('fetch', fetch);
    await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const signal = fetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
  });
});
