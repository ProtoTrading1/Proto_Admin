/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductLoaderPanel from '../src/components/ProductLoaderPanel.jsx';
import { lookupFilenames } from '../src/lib/productLoaderApi.js';

vi.mock('../src/lib/productLoaderApi.js', () => ({
  lookupFilenames: vi.fn(), importLocalShipmentToInstore: vi.fn(), archiveLoaderImageItem: vi.fn(),
  correctLocalShipmentInstoreQuantity: vi.fn(), logPublishFailure: vi.fn(), publishLoaderColourVariant: vi.fn(),
  publishLoaderImageItem: vi.fn(), reconcileInstoreLandedStock: vi.fn(), syncLoaderColourVariantGroup: vi.fn(),
}));
vi.mock('../src/lib/taxonomyAdmin', () => ({
  subcategoryOptionsFromTree: (tree, id) => tree.find((node) => node.id === id)?.children || [],
}));
vi.mock('../src/components/productLoader/ProductLoaderNutstore', () => ({ default: () => <p>Nutstore test panel</p> }));
vi.mock('../src/components/productLoader/ProductLoaderSingleImage', () => ({ default: () => <p>Single image test panel</p> }));
vi.mock('../src/components/productLoader/ProductLoaderVariantImport', () => ({ default: () => <p>Excel test panel</p> }));
vi.mock('../src/components/productLoader/ProductLoaderPublishSuccess', () => ({ default: () => null }));
vi.mock('../src/components/productLoader/ImageProcessingCentre', () => ({ default: () => null }));

let container;
let root;
const button = (text) => [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
async function click(node) {
  expect(node).toBeTruthy();
  await act(async () => node.click());
}
async function change(node, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => url === '/api/nutstore-process'
      ? { instoreLandedImportEnabled: true, schemaReady: true }
      : url === '/api/product-loader-dormant' ? { rows: [] } : {},
  })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:landed-session');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Product Loader landed-session lifecycle', () => {
  it('preserves stock mode, loaded images, selection, and destination across parent tab switches', async () => {
    lookupFilenames.mockImplementation(async (_names, files) => files.map((file) => ({
      code: '8620200200', filename: file.name, file, previewUrl: 'blob:landed-session',
      description: 'Rhinestone stickers', title: 'Rhinestone stickers', price: 12.5,
      positillSource: 'erp_sql', warnings: [], group: 'ready', canPublish: true,
      unitsOfIssue: 'CARD', canonicalSellingUnitKnown: true,
      sqlRow: { CODE: '8620200200', UNITS: 'CARD', ONHAND: 30, BOOKED: 0 },
    })));
    const pending = vi.fn();
    await act(async () => root.render(<ProductLoaderPanel onPendingWorkChange={pending} />));
    expect(pending).toHaveBeenLastCalledWith(false);

    const liveMode = [...container.querySelectorAll('input[type="radio"]')]
      .find((node) => node.parentElement.textContent.includes('live Positill stock'));
    await click(liveMode);
    const input = container.querySelector('.pl-landed-panel input[webkitdirectory]');
    const file = new File(['image'], '8620200200.jpg', { type: 'image/jpeg' });
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file, new File(['svg'], '8620200201.svg', { type: 'image/svg+xml' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(lookupFilenames.mock.calls[0][0]).toEqual(['8620200200.jpg']);
    expect(container.textContent).toContain('Convert to JPG, PNG or WebP');
    const productCheckbox = container.querySelector('.pl-landed-panel [role="listitem"] input[type="checkbox"]');
    await click(productCheckbox);
    const mainCategory = [...container.querySelectorAll('.pl-landed-panel select')]
      .find((node) => [...node.options].some((option) => option.value === 'arts-and-crafts'));
    await change(mainCategory, 'arts-and-crafts');
    await click(button('Assign category to selected (1)'));
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('.pl-landed-panel').textContent).toContain('Destination: Arts and Crafts');

    await click(button('Single Image'));
    expect(container.querySelector('.pl-landed-panel').hidden).toBe(true);
    expect(container.textContent).toContain('Single image test panel');
    expect(pending).toHaveBeenLastCalledWith(true);
    await click(button('Landed Shipment'));

    const landed = container.querySelector('.pl-landed-panel');
    expect(landed.hidden).toBe(false);
    expect(landed.querySelector('input[type="radio"][name="instore-stock-source"]:checked')
      .parentElement.textContent).toContain('live Positill stock');
    expect(landed.querySelector('[role="listitem"] input[type="checkbox"]').checked).toBe(true);
    expect(landed.textContent).toContain('Destination: Arts and Crafts');
    expect(lookupFilenames).toHaveBeenCalledOnce();
    const currentInput = landed.querySelector('input[webkitdirectory]');
    await act(async () => {
      Object.defineProperty(currentInput, 'files', { configurable: true, value: [new File(['svg'], '8620200202.svg', { type: 'image/svg+xml' })] });
      currentInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(lookupFilenames).toHaveBeenCalledOnce();
    expect(landed.querySelector('[role="listitem"] input[type="checkbox"]').checked).toBe(true);
    expect(landed.textContent).toContain('Destination: Arts and Crafts');
    expect(landed.textContent).toContain('Your current batch has not been changed');
    await act(async () => root.render(<p>Other section</p>));
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it('keeps navigation and unload warnings armed after an initial scan fails', async () => {
    lookupFilenames.mockRejectedValue(new Error('Live lookup unavailable'));
    const pending = vi.fn();
    await act(async () => root.render(<ProductLoaderPanel onPendingWorkChange={pending} />));
    const input = container.querySelector('.pl-landed-panel input[webkitdirectory]');
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], '8620200200.jpg', { type: 'image/jpeg' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Live lookup unavailable');
    expect(pending).toHaveBeenLastCalledWith(true);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await act(async () => root.render(<p>Other section</p>));
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(false);
  });
});
