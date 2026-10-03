/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstoreCopyEditor from '../src/components/productLoader/InstoreCopyEditor.jsx';
import { loadInstoreCopy, updateInstoreCopy } from '../src/lib/instoreCopyApi.js';

vi.mock('../src/lib/instoreCopyApi.js', () => ({ loadInstoreCopy: vi.fn(), updateInstoreCopy: vi.fn() }));
const item = { sku: '78446', title: 'CROCHET TOTOE BAG KIT', original_description: 'CROCHET TOTOE BAG KIT', price: 109.5, available_stock: 12, updated_at: '2026-10-03T10:00:00Z' };
let container, root, pending;
const button = (name) => [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === name);
const input = (name) => container.querySelector(`[aria-label="${name}"]`);
async function click(node) { expect(node).toBeTruthy(); await act(async () => node.click()); }
async function fill(node, value) {
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function find() { await fill(input('Exact Instore product code'), '78446'); await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal('React', React); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); pending = vi.fn();
  loadInstoreCopy.mockResolvedValue({ item, canEdit: true });
  await act(async () => root.render(<InstoreCopyEditor onPendingChange={pending} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('listed Instore website wording editor', () => {
  it('does not load or save on mount; loads exact code and keeps identity/price/stock read-only', async () => {
    expect(loadInstoreCopy).not.toHaveBeenCalled(); expect(updateInstoreCopy).not.toHaveBeenCalled();
    await find(); expect(loadInstoreCopy).toHaveBeenCalledWith('78446');
    expect(container.querySelector('.ic-record').textContent).toContain('R 109.50 · 12 available');
    expect(button('Review website changes').disabled).toBe(true);
  });
  it('requires review/confirmation, saves capitals, and clears the pending warning only after acknowledgement', async () => {
    await find(); await fill(input('Website name 78446'), 'crochet tote bag kit'); await fill(input('Website description 78446'), 'kit with yarn and hook');
    expect(input('Website name 78446').value).toBe('CROCHET TOTE BAG KIT'); expect(pending).toHaveBeenLastCalledWith(true);
    await click(button('Review website changes')); expect(container.querySelector('dl').textContent).toContain('CROCHET TOTOE BAG KIT');
    expect(container.querySelector('dl').textContent).toContain('KIT WITH YARN AND HOOK'); expect(updateInstoreCopy).not.toHaveBeenCalled();
    updateInstoreCopy.mockResolvedValue({ ok: true, item: { ...item, title: 'CROCHET TOTE BAG KIT', original_description: 'KIT WITH YARN AND HOOK', updated_at: '2026-10-03T11:00:00Z' } });
    await click(button('Confirm save website wording'));
    expect(updateInstoreCopy).toHaveBeenCalledWith(item, { title: 'CROCHET TOTE BAG KIT', description: 'KIT WITH YARN AND HOOK' });
    expect(container.querySelector('[role="status"]').textContent).toContain('Saved website wording for 78446'); expect(pending).toHaveBeenLastCalledWith(false);
  });
  it('cancel discards text without saving and blank or HTML input cannot be submitted', async () => {
    await find(); await fill(input('Website name 78446'), ''); expect(button('Review website changes').disabled).toBe(true);
    await fill(input('Website name 78446'), '<b>bad</b>'); expect(button('Review website changes').disabled).toBe(true);
    await click(button('Cancel changes')); expect(input('Website name 78446').value).toBe(item.title); expect(updateInstoreCopy).not.toHaveBeenCalled(); expect(pending).toHaveBeenLastCalledWith(false);
  });
  it('preserves an unconfirmed draft and prevents blind retries until the saved version is reloaded', async () => {
    await find(); await fill(input('Website name 78446'), 'new name'); await click(button('Review website changes'));
    updateInstoreCopy.mockRejectedValue(new Error('This item changed. Reload it.'));
    await click(button('Confirm save website wording'));
    expect(input('Website name 78446').value).toBe('NEW NAME'); expect(container.querySelector('[role="alert"]').textContent).toContain('changed');
    expect(button('Confirm save website wording').disabled).toBe(true); expect(button('Reload saved wording')).toBeTruthy(); expect(pending).toHaveBeenLastCalledWith(true);
  });
  it('disables save controls on a preview, independent of client edits', async () => {
    loadInstoreCopy.mockResolvedValue({ item, canEdit: false }); await find();
    expect(container.textContent).toContain('saving website wording is disabled'); expect(input('Website name 78446').closest('fieldset').disabled).toBe(true); expect(button('Review website changes').disabled).toBe(true);
  });
  it('opens a listed row by exact code without discarding dirty edits silently', async () => {
    await find(); await fill(input('Website name 78446'), 'new name'); vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => root.render(<InstoreCopyEditor onPendingChange={pending} openRequest={{ sku: '78445' }} />));
    expect(loadInstoreCopy).toHaveBeenCalledOnce(); expect(input('Website name 78446').value).toBe('NEW NAME');
  });
});
