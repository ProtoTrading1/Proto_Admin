/* @vitest-environment happy-dom */
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRODUCT_LOADER_LEAVE_MESSAGE, useProductLoaderLeaveGuard } from '../src/hooks/useProductLoaderLeaveGuard.js';

let root;
let container;
let guard;
function Harness() {
  const [section, setSection] = useState('product-loader');
  guard = useProductLoaderLeaveGuard(setSection);
  return <p>{section}</p>;
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not prompt for an empty review or choosing the current loader section', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => { expect(guard.requestSectionChange('pricing')).toBe(true); });
  expect(container.textContent).toBe('pricing');
  guard.onPendingWorkChange(true);
  await act(async () => { expect(guard.requestSectionChange('product-loader')).toBe(true); });
  expect(confirm).not.toHaveBeenCalled();
});

it('cancel blocks repeated exit attempts without consuming pending work; OK permits navigation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  guard.onPendingWorkChange(true);
  for (const destination of ['pricing', 'orders', 'image-processing']) {
    await act(async () => { expect(guard.requestSectionChange(destination)).toBe(false); });
    expect(container.textContent).toBe('product-loader');
  }
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(confirm).toHaveBeenLastCalledWith(PRODUCT_LOADER_LEAVE_MESSAGE);
  confirm.mockReturnValue(true);
  await act(async () => { expect(guard.requestSectionChange('pricing')).toBe(true); });
  expect(container.textContent).toBe('pricing');
  guard.onPendingWorkChange(false); // child's unmount cleanup
  confirm.mockClear();
  await act(async () => guard.requestSectionChange('orders'));
  expect(confirm).not.toHaveBeenCalled();
});

it('the same confirmation protects portal and sign-out callbacks', () => {
  const action = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  guard.onPendingWorkChange(true);
  if (guard.confirmLeave()) action();
  expect(action).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  if (guard.confirmLeave()) action();
  expect(action).toHaveBeenCalledOnce();
});

it('wires every admin section change through the guard and guards external exits before invoking them', () => {
  const source = readFileSync('src/pages/AdminPage.jsx', 'utf8');
  expect(source.match(/setActiveSectionState/g)).toHaveLength(2); // declaration + guarded hook only
  expect(source).toContain('requestSectionChange: setActiveSection } = useProductLoaderLeaveGuard(setActiveSectionState)');
  expect(source).toContain('if (!setActiveSection(id)) return;');
  expect(source).toContain('if (confirmProductLoaderLeave()) onViewPortal?.();');
  expect(source).toContain('if (confirmProductLoaderLeave()) onSignOut();');
  expect(source).toContain('onPendingWorkChange={onProductLoaderPendingWorkChange}');
  expect(source.indexOf("if (!setActiveSection('image-processing')) return;")).toBeLessThan(source.indexOf('const nutstoreSelection = savePendingNutstoreHandoff('));
});
