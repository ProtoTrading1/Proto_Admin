/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const { updateProduct } = vi.hoisted(() => ({ updateProduct: vi.fn() }));
vi.mock('../src/lib/products', () => ({ updateProduct, setLiveTaxonomyTree: vi.fn() }));

import BulkProductEditModal from '../src/components/BulkProductEditModal.jsx';

const products = [
  { sku: 'GERMOL-5ALOE', title: 'GERMOL HYGIENE SOAP ALOE 175g', description: 'Aloe soap' },
  { sku: 'GERMOL-4MENTHOL', title: 'GERMOL HYGIENE SOAP MENTHOL 175g', description: 'Menthol soap' },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function renderModal() {
  vi.stubGlobal('React', React);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  updateProduct.mockResolvedValue({});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<BulkProductEditModal products={products} taxonomyTree={[]} />));
  return { container, root };
}

async function setValue(element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button) {
  await act(async () => button.click());
}

it('edits one soap name independently without changing its sibling or description', async () => {
  const { container, root } = await renderModal();
  const cards = [...container.querySelectorAll('.pm-bulk-edit-card')];
  const nameInputs = cards.map((card) => [...card.querySelectorAll('label')]
    .find((label) => label.querySelector('span')?.textContent === 'Product name (shown on website)')?.querySelector('input'));
  expect(nameInputs.map((input) => input?.value)).toEqual(products.map((product) => product.title));

  await setValue(nameInputs[0], 'GERMOL HYGIENE SOAP ALOE & TEA TREE 175g');
  expect(nameInputs[1].value).toBe(products[1].title);
  expect(cards[0].querySelector('textarea').value).toBe('Aloe soap');
  expect(cards[1].querySelector('textarea').value).toBe('Menthol soap');

  await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Save all changes')));
  expect(updateProduct).toHaveBeenCalledTimes(1);
  expect(updateProduct).toHaveBeenCalledWith('GERMOL-5ALOE', { name: 'GERMOL HYGIENE SOAP ALOE & TEA TREE 175g' });
  await act(async () => root.unmount());
});

it('keeps each soap description separate when editing without the shared shortcut', async () => {
  const { container, root } = await renderModal();
  const cards = [...container.querySelectorAll('.pm-bulk-edit-card')];
  await setValue(cards[0].querySelector('textarea'), 'Aloe and tea tree soap');
  expect(cards[1].querySelector('textarea').value).toBe('Menthol soap');

  await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Save all changes')));
  expect(updateProduct).toHaveBeenCalledTimes(1);
  expect(updateProduct).toHaveBeenCalledWith('GERMOL-5ALOE', { description: 'Aloe and tea tree soap' });
  await act(async () => root.unmount());
});

it('requires review before applying shared text and preserves each soap name', async () => {
  const { container, root } = await renderModal();
  const shared = container.querySelector('.pm-bulk-apply-description textarea');
  const cards = [...container.querySelectorAll('.pm-bulk-edit-card')];
  await setValue(shared, 'A shared soap description');

  await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Review before applying')));
  expect(container.querySelector('.pm-bulk-shared-review').textContent).toContain('Aloe soap');
  expect(container.querySelector('.pm-bulk-shared-review').textContent).toContain('Menthol soap');
  expect(cards.map((card) => card.querySelector('textarea').value)).toEqual(['Aloe soap', 'Menthol soap']);
  expect([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Finish description review first')).disabled).toBe(true);

  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel'));
  expect(container.querySelector('.pm-bulk-shared-review')).toBeNull();
  expect(cards.map((card) => card.querySelector('textarea').value)).toEqual(['Aloe soap', 'Menthol soap']);

  await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Review before applying')));
  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Apply to draft'));
  expect(cards.map((card) => card.querySelector('textarea').value)).toEqual([
    'A shared soap description', 'A shared soap description',
  ]);
  expect(updateProduct).not.toHaveBeenCalled();

  await click([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Save all changes')));
  expect(updateProduct).toHaveBeenCalledTimes(2);
  expect(updateProduct).toHaveBeenCalledWith('GERMOL-5ALOE', { description: 'A shared soap description' });
  expect(updateProduct).toHaveBeenCalledWith('GERMOL-4MENTHOL', { description: 'A shared soap description' });
  await act(async () => root.unmount());
});
