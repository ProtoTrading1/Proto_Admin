/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DeliveryLabelCopy from '../src/components/DeliveryLabelCopy.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let host;
const customer = { business_name: 'Sample Shop', contact_name: 'Jane Smith', phone: '0820012345',
  delivery_address: '8 Example Avenue, Sedgefield, Western Cape, 6573, South Africa' };
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.unstubAllGlobals(); });
async function render(value = customer) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<DeliveryLabelCopy customer={value} />));
}
it('shows the exact readonly label and copies only its values', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('ClipboardItem', undefined);
  await render();
  const textarea = host.querySelector('textarea');
  expect(textarea.readOnly).toBe(true);
  expect(textarea.value.split('\n')).toHaveLength(7);
  await act(async () => host.querySelector('button').click());
  expect(writeText.mock.calls[0][0]).toBe(textarea.value.replace(/\r?\n/g, '\r\n'));
  expect(host.querySelector('[role="status"]').textContent).toContain('Copied as plain text');
});
it('selects the visible label for manual copying after clipboard denial', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.stubGlobal('ClipboardItem', undefined);
  await render();
  await act(async () => host.querySelector('button').click());
  const area = host.querySelector('textarea');
  expect(document.activeElement).toBe(area);
  expect(area.selectionStart).toBe(0);
  expect(area.selectionEnd).toBe(area.value.length);
  expect(host.querySelector('[role="status"]').textContent).toContain('press Ctrl+C');
});
it('disables copying when the address is missing', async () => {
  await render({ business_name: 'Sample Shop' });
  expect(host.querySelector('button').disabled).toBe(true);
  expect(host.textContent).toContain('No full address is saved');
});
it('shows missing-province warning and copies its blank row without moving contact or phone', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('ClipboardItem', undefined);
  await render({ ...customer, city: 'Sedgefield', delivery_address: '8 Example Avenue, Sedgefield, Sedgefield, 6573, South Africa, Office' });
  expect(host.querySelector('[role="alert"]').textContent).toContain('Province is missing');
  expect(host.querySelector('textarea').value.split(/\r?\n/)).toHaveLength(7);
  await act(async () => host.querySelector('button').click());
  const lines = writeText.mock.calls[0][0].split('\r\n');
  expect(lines[3]).toBe('');
  expect(lines.slice(4)).toEqual(['6573','JANE SMITH','0820012345']);
});
