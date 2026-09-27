/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstoreReview from '../src/components/productLoader/InstoreReview.jsx';
import { buildInstoreReview } from '../src/lib/instoreReview.js';
import ProductLoaderUpload from '../src/components/productLoader/ProductLoaderUpload.jsx';
import { lookupFilenames, importLocalShipmentToInstore, publishLoaderImageItem } from '../src/lib/productLoaderApi.js';
import { clearProductLoaderUploadDraft } from '../src/lib/productLoaderUploadDraft.js';

vi.mock('../src/lib/productLoaderApi.js', () => ({
  lookupFilenames: vi.fn(), importLocalShipmentToInstore: vi.fn(),
  archiveLoaderImageItem: vi.fn(), correctLocalShipmentInstoreQuantity: vi.fn(),
  logPublishFailure: vi.fn(), publishLoaderColourVariant: vi.fn(), publishLoaderImageItem: vi.fn(),
  reconcileInstoreLandedStock: vi.fn(), syncLoaderColourVariantGroup: vi.fn(),
}));
vi.mock('../src/lib/taxonomyAdmin', () => ({
  subcategoryOptionsFromTree: (tree, id) => tree.find((node) => node.id === id)?.children || [],
}));

function product(code, extra = {}) {
  return { code, filename: `${code}.jpg`, file: {}, description: `${code} stickers`, price: 12.5,
    instoreCategoryPath: ['Crafts', 'Stickers'], ...extra };
}
function review(rows) {
  return buildInstoreReview(rows, { isReady: (row) => !row.blocker, getBlocker: (row) => row.blocker || '' });
}

let container;
let root;
let props;
const button = (text) => [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
const articles = () => [...container.querySelectorAll('[role="listitem"]')];
async function click(node) {
  expect(node).toBeTruthy();
  await act(async () => node.click());
}
async function change(node, value) {
  const prototype = node.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function render(overrides = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(<InstoreReview {...props} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearProductLoaderUploadDraft();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    entries: review([product('A'), product('B'), product('LISTED', { existingInstore: true })]),
    selected: new Set(), busy: false, importEnabled: true,
    importBlockReason: 'Select at least one product.', canAssignCategory: true,
    categoryPicker: <label>Category picker<select aria-label="Category picker"><option>Crafts</option><option>Jewellery</option></select></label>,
    onAssignCategory: vi.fn(), onSelect: vi.fn(), onClearSelection: vi.fn(),
    onImport: vi.fn(), onRefresh: vi.fn(), onRetryFailed: vi.fn(), stockMode: 'positill_live',
    stockInfo: () => ({ label: '30 cards available', details: 'Positill unit: CARD; 30 on hand − 0 booked' }),
  };
});

const taxonomyTree = [
  { id: 'crafts', label: 'Crafts', children: [] },
  { id: 'jewellery', label: 'Jewellery', children: [] },
];
function UploadHarness({ initialTree = taxonomyTree, exposeTree }) {
  const [path, setPath] = React.useState([]);
  const [tree, setTree] = React.useState(initialTree);
  exposeTree?.(setTree);
  return <ProductLoaderUpload instoreOnly taxonomyTree={tree} batchDefaultPathIds={path}
    setBatchDefaultPathIds={setPath} batchOverwrite={false} setBatchOverwrite={() => {}} />;
}
async function loadShipment(rows, { enabled = true } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instoreLandedImportEnabled: enabled, schemaReady: true }) }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-product');
  lookupFilenames.mockImplementation(async (_names, files) => rows.map((row, index) => ({
    ...product(row.code), title: 'RHINESTONE STICKERS', positillSource: 'erp_sql', warnings: [],
    group: 'ready', canPublish: true, unitsOfIssue: 'CARD', canonicalSellingUnitKnown: true,
    sqlRow: { CODE: row.code, UNITS: 'CARD', ONHAND: 30, BOOKED: 0 },
    ...row, file: files.find((file) => file.name === `${row.code}${index ? '-2' : ''}.jpg`), filename: `${row.code}${index ? '-2' : ''}.jpg`,
  })));
  await act(async () => root.render(<UploadHarness />));
  const liveRadio = [...container.querySelectorAll('input[type="radio"]')].find((node) => node.parentElement.textContent.includes('live Positill stock'));
  await click(liveRadio);
  const input = container.querySelector('input[webkitdirectory]');
  const files = rows.map((row, index) => new File(['image'], `${row.code}${index ? '-2' : ''}.jpg`, { type: 'image/jpeg' }));
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return files;
}

describe('Product Loader Instore integration', () => {
  it('clears a destination when a previously assigned child category no longer exists', async () => {
    const withChild = [
      { id: 'crafts', label: 'Crafts', children: [{ id: 'stickers', label: 'Stickers', children: [] }] },
      { id: 'jewellery', label: 'Jewellery', children: [] },
    ];
    let updateTree;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instoreLandedImportEnabled: true, schemaReady: true }) }));
    await act(async () => root.render(<UploadHarness initialTree={withChild} exposeTree={(setTree) => { updateTree = setTree; }} />));
    const input = container.querySelector('input[webkitdirectory]');
    const file = new File(['image'], '8620200200.jpg', { type: 'image/jpeg' });
    lookupFilenames.mockImplementation(async (_names, files) => [{
      ...product('8620200200'), title: 'RHINESTONE STICKERS', positillSource: 'erp_sql', warnings: [],
      group: 'ready', canPublish: true, unitsOfIssue: 'CARD', canonicalSellingUnitKnown: true,
      sqlRow: { CODE: '8620200200', UNITS: 'CARD', ONHAND: 30, BOOKED: 0 }, file: files[0], filename: files[0].name,
    }]);
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(articles()[0].querySelector('input'));
    const pickers = [...container.querySelectorAll('select')];
    await change(pickers.find((node) => [...node.options].some((option) => option.value === 'crafts')), 'crafts');
    await change([...container.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'stickers')), 'stickers');
    await click(button('Assign category to selected (1)'));
    expect(articles()[0].textContent).toContain('Destination: Crafts › Stickers');
    await act(async () => updateTree(taxonomyTree));
    expect(articles()[0].textContent).toContain('Destination: Unassigned');
  });

  it('shows retryable status failure without calling it a preview, then reports confirmed preview status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ instoreLandedImportEnabled: false, schemaReady: true }) }));
    await act(async () => root.render(<UploadHarness />));
    expect(container.querySelector('.ir-preview')).toBeNull();
    expect(container.querySelector('[role="alert"]').textContent).toContain('status could not be confirmed');
    expect(button('Retry status check')).toBeTruthy();
    await click(button('Retry status check'));
    expect(container.querySelector('.ir-preview').textContent).toContain('Test preview');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(importLocalShipmentToInstore).not.toHaveBeenCalled();
  });

  it('selects before assigning, preserves saved destinations, and imports once per unique SKU', async () => {
    const files = await loadShipment([{ code: '8620200200' }, { code: '8620200200', imageSlot: 2 }]);
    importLocalShipmentToInstore.mockResolvedValue({ outcome: 'added', ok: true, sku: '8620200200', action: 'instore_import' });
    expect(articles()).toHaveLength(1);
    const checkbox = articles()[0].querySelector('input');
    expect(checkbox.disabled).toBe(false);
    await click(checkbox);
    expect(articles()[0].textContent).toContain('Unassigned');
    const picker = [...container.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'crafts'));
    await change(picker, 'crafts');
    expect(articles()[0].textContent).toContain('Unassigned');
    await click(button('Assign category to selected (1)'));
    expect(articles()[0].textContent).toContain('Destination: Crafts');
    await change(picker, 'jewellery');
    expect(articles()[0].textContent).toContain('Destination: Crafts');
    await click(button('Review and add to Instore'));
    await click(button('Confirm add 1 product to Instore'));
    expect(importLocalShipmentToInstore).toHaveBeenCalledOnce();
    expect(importLocalShipmentToInstore).toHaveBeenCalledWith(expect.objectContaining({ file: files[0] }),
      expect.objectContaining({ category: 'Crafts', categoryPath: ['Crafts'], stockMode: 'positill_live' }));
    expect(container.querySelector('[aria-label="Import results"]').textContent).toContain('Added: 1');
    expect(container.querySelector('[aria-label="Instore selection actions"]').textContent).toContain('0 products selected');
  });

  it('retains a failed selection and distinguishes a server duplicate from an added product', async () => {
    await loadShipment([{ code: '8620200200' }, { code: '8620200201' }]);
    importLocalShipmentToInstore.mockImplementation(async (row) => {
      if (row.code === '8620200200') return { outcome: 'skipped', ok: true, sku: row.code, action: 'instore_skipped', skipped: true, reason: 'already_in_instore', message: 'Already in Instore' };
      throw new Error('Live Positill stock unavailable');
    });
    await click(button('Select reviewable products in these results (2)'));
    const picker = [...container.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'crafts'));
    await change(picker, 'crafts');
    await click(button('Assign category to selected (2)'));
    await click(button('Review and add to Instore'));
    await click(button('Confirm add 2 products to Instore'));
    const results = container.querySelector('[aria-label="Import results"]');
    expect(results.textContent).toContain('Added: 0');
    expect(results.textContent).toContain('Skipped (already listed): 1');
    expect(results.textContent).toContain('Failed: 1');
    expect(results.textContent).toContain('Live Positill stock unavailable');
    expect(container.querySelector('[aria-label="Instore selection actions"]').textContent).toContain('1 product selected');
    expect(importLocalShipmentToInstore).toHaveBeenCalledTimes(2);
    await click(button('Review failed products for retry (1)'));
    expect(lookupFilenames).toHaveBeenLastCalledWith(['8620200201-2.jpg'], [expect.any(File)], { strictExact: true, groupColourVariants: false });
    expect(importLocalShipmentToInstore).toHaveBeenCalledTimes(2);
    expect(articles().find((node) => node.textContent.includes('8620200201')).textContent).toContain('Destination: Crafts');
  });

  it('preserves image-level publishing and draft behavior in normal Multiple Images uploads', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-normal');
    const files = [new File(['image'], '8620200200.jpg', { type: 'image/jpeg' }),
      new File(['image'], '8620200200-2.jpg', { type: 'image/jpeg' })];
    lookupFilenames.mockImplementation(async (_names, selectedFiles) => selectedFiles.map((file, index) => ({
      ...product('8620200200'), file, filename: file.name, imageSlot: index + 1,
      title: 'RHINESTONE STICKERS', group: 'ready', canPublish: true, warnings: [],
    })));
    publishLoaderImageItem.mockResolvedValue({ ok: true });
    await act(async () => root.render(<ProductLoaderUpload taxonomyTree={taxonomyTree}
      batchDefaultPathIds={['crafts']} setBatchDefaultPathIds={() => {}}
      batchOverwrite={false} setBatchOverwrite={() => {}} />));
    const input = container.querySelector('input[type="file"]:not([webkitdirectory])');
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lookupFilenames).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), { strictExact: false, groupColourVariants: true });
    expect(container.querySelector('[aria-label="Review products for Instore"]')).toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(button('Publish All Ready (2)')).toBeTruthy();
    expect(button('Send All to Archive (incl. not found)')).toBeTruthy();
    await click(button('Publish All Ready (2)'));
    expect(publishLoaderImageItem).toHaveBeenCalledTimes(2);
    expect(importLocalShipmentToInstore).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearProductLoaderUploadDraft();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Instore review controls', () => {
  it('hides existing products initially and reveals them as disabled in the existing-item filter', async () => {
    await render();
    expect(articles()).toHaveLength(2);
    expect(articles().some((node) => node.textContent.includes('LISTED'))).toBe(false);
    const show = [...container.querySelectorAll('select')].find((node) => node.value === 'working');
    await change(show, 'instore');
    expect(articles()).toHaveLength(1);
    expect(articles()[0].textContent).toContain('LISTED');
    expect(articles()[0].querySelector('input').disabled).toBe(true);
    await click(articles()[0].querySelector('input'));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('limits bulk selection to currently filtered reviewable products', async () => {
    await render({ entries: review([product('A', { description: 'Blue stickers' }), product('B', { description: 'Metal beads' })]) });
    await change(container.querySelector('input[type="search"]'), 'metal');
    expect(articles()).toHaveLength(1);
    await click(button('Select reviewable products in these results (1)'));
    expect(props.onSelect).toHaveBeenCalledWith(['B.jpg'], true);
  });

  it('keeps selected products counted when filtered out and restores selected-only visibility', async () => {
    await render({ selected: new Set(['A.jpg']), importBlockReason: '' });
    await change(container.querySelector('input[type="search"]'), 'B stickers');
    expect(articles()).toHaveLength(1);
    expect(container.querySelector('[aria-label="Instore selection actions"]').textContent).toContain('1 product selected');
    await change(container.querySelector('input[type="search"]'), '');
    await click(button('Selected only'));
    expect(articles()).toHaveLength(1);
    expect(articles()[0].querySelector('input').checked).toBe(true);
    expect(articles()[0].textContent).toContain('A stickers');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('requires an explicit assignment action after changing the batch picker', async () => {
    await render({ selected: new Set(['A.jpg']) });
    await change(container.querySelector('[aria-label="Category picker"]'), 'Jewellery');
    expect(props.onAssignCategory).not.toHaveBeenCalled();
    expect(articles()[0].textContent).toContain('Crafts › Stickers');
    await click(button('Assign category to selected (1)'));
    expect(props.onAssignCategory).toHaveBeenCalledOnce();
    await click(button('Clear selection'));
    expect(props.onClearSelection).toHaveBeenCalledOnce();
  });

  it('shows saved destinations in a final summary before invoking import', async () => {
    await render({ entries: review([product('A'), product('B', { instoreCategoryPath: ['Jewellery', 'Beads'] })]),
      selected: new Set(['A.jpg', 'B.jpg']), importBlockReason: '' });
    await click(button('Review and add to Instore'));
    expect(props.onImport).not.toHaveBeenCalled();
    const summary = container.querySelector('[aria-label="Final Instore review"]');
    expect(summary.textContent).toContain('Crafts › Stickers · 1');
    expect(summary.textContent).toContain('Jewellery › Beads · 1');
    await click(button('Confirm add 2 products to Instore'));
    expect(props.onImport).toHaveBeenCalledOnce();
  });

  it('keeps preview restrictions next to the action and prevents import', async () => {
    await render({ selected: new Set(['A.jpg']), importEnabled: false, importBlockReason: 'Test preview — adding products is disabled' });
    const actions = container.querySelector('[aria-label="Instore selection actions"]');
    expect(actions.textContent).toContain('Test preview — adding products is disabled');
    expect(button('Review and add to Instore').disabled).toBe(true);
    await click(button('Review and add to Instore'));
    expect(props.onImport).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Final Instore review"]')).toBeNull();
  });

  it('blocks selected products needing attention and explains missing prices and selling units', async () => {
    await render({ entries: review([product('A', { price: null, blocker: 'Choose a destination.', instoreCategoryPath: [] })]),
      selected: new Set(['A.jpg']), importBlockReason: '' });
    expect(button('Review and add to Instore').disabled).toBe(true);
    expect(articles()[0].textContent).toContain('Price unavailable');
    expect(articles()[0].textContent).not.toContain('R 0.00');
    expect(articles()[0].textContent).toContain('30 cards available');
    expect(articles()[0].textContent).toContain('Positill unit: CARD; 30 on hand − 0 booked');
    expect(articles()[0].textContent).toContain('Destination: Unassigned');
    expect(container.querySelector('[aria-label="Instore selection actions"]').textContent).toContain('1 need attention');
  });

  it('reports added, skipped and failed results separately with a failed-only retry action', async () => {
    await render({ receipt: [
      { sku: 'A', outcome: 'added', reason: 'Confirmed by server', url: '/?section=instore&sku=A' },
      { sku: 'B', outcome: 'skipped', reason: 'Already in Instore' },
      { sku: 'C', outcome: 'failed', reason: 'Live stock unavailable' },
    ] });
    const results = container.querySelector('[aria-label="Import results"]');
    expect(results.textContent).toContain('Added: 1');
    expect(results.textContent).toContain('Skipped (already listed): 1');
    expect(results.textContent).toContain('Failed: 1');
    expect(results.textContent).toContain('C — Failed');
    expect(results.querySelector('a').getAttribute('href')).toBe('/?section=instore&sku=A');
    await click(button('Review failed products for retry (1)'));
    expect(props.onRetryFailed).toHaveBeenCalledOnce();
    expect(props.onImport).not.toHaveBeenCalled();
  });
});
