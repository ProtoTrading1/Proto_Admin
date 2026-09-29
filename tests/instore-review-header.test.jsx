/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import InstoreReview from '../src/components/productLoader/InstoreReview.jsx';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('keeps the review bar below the real admin header and responds to header wrapping', async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const header = document.createElement('header');
  header.className = 'adm-header';
  let height = 52;
  header.getBoundingClientRect = () => ({ height });
  document.body.appendChild(header);
  let notify;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { notify = callback; } observe = observe; disconnect = disconnect; });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<InstoreReview entries={[]} selected={new Set()} stockInfo={() => ({})} importEnabled={false} />));
  const review = container.querySelector('.instore-review');
  expect(review.style.getPropertyValue('--ir-header-offset')).toBe('52px');
  expect(observe).toHaveBeenCalledWith(header);
  height = 99.2;
  notify();
  expect(review.style.getPropertyValue('--ir-header-offset')).toBe('100px');
  height = 58;
  window.dispatchEvent(new Event('resize'));
  expect(review.style.getPropertyValue('--ir-header-offset')).toBe('58px');
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  const css = readFileSync('src/components/productLoader/InstoreReview.css', 'utf8');
  expect(css).toContain('top: calc(var(--ir-header-offset, 0px) + 8px)');
  expect(css).toContain('.pl-landed-panel:not([hidden])');
});
