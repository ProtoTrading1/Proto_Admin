/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductLoaderPanel from '../src/components/ProductLoaderPanel.jsx';
import { lookupFilenames } from '../src/lib/productLoaderApi.js';

vi.mock('../src/lib/productLoaderApi.js', () => ({
  lookupFilenames: vi.fn(), importLocalShipmentToInstore: vi.fn(), archiveLoaderImageItem: vi.fn(),
  correctLocalShipmentInstoreQuantity: vi.fn(), logPublishFailure: vi.fn(), publishLoaderColourVariant: vi.fn(),
  publishLoaderImageItem: vi.fn(), reconcileInstoreLandedStock: vi.fn(), syncLoaderColourVariantGroup: vi.fn(),
}));
vi.mock('../src/lib/taxonomyAdmin', () => ({ subcategoryOptionsFromTree: () => [] }));
vi.mock('../src/components/productLoader/ProductLoaderNutstore', () => ({ default: () => null }));
vi.mock('../src/components/productLoader/ProductLoaderSingleImage', () => ({ default: () => null }));
vi.mock('../src/components/productLoader/ProductLoaderVariantImport', () => ({ default: () => null }));
vi.mock('../src/components/productLoader/ProductLoaderPublishSuccess', () => ({ default: () => null }));
vi.mock('../src/components/productLoader/ImageProcessingCentre', () => ({ default: () => null }));

let container;
let root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url) => ({ ok: true, json: async () => url === '/api/nutstore-process' ? { instoreLandedImportEnabled: true, schemaReady: true } : { rows: [] } })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:family');
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

it('stages one chosen group photo for five verified variants without importing or using the second photo', async () => {
  lookupFilenames.mockImplementation(async (_names, files) => files.map((file) => {
    const code = file.name.split('.')[0].replace(/-1$/, '');
    const variant = /[BHMPU]$/.test(code) && code.length === 11;
    return {
      code, filename: file.name, file, group: variant ? 'ready' : 'not_found',
      description: 'STORAGE BAG', price: 45, positillSource: variant ? 'erp_sql' : 'unavailable',
      unitsOfIssue: 'EACH', canonicalSellingUnitKnown: variant,
      sqlRow: variant ? { CODE: code, UNITS: 'EACH', ONHAND: 20, BOOKED: 0 } : null,
    };
  }));
  await act(async () => root.render(<ProductLoaderPanel />));
  const liveMode = [...container.querySelectorAll('input[type="radio"]')].find((node) => node.parentElement.textContent.includes('live Positill stock'));
  await act(async () => liveMode.click());
  const input = container.querySelector('.pl-landed-panel input[webkitdirectory]');
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [
      new File(['family'], '8626000775.jpg', { type: 'image/jpeg' }),
      new File(['details'], '8626000775-1.jpg', { type: 'image/jpeg' }),
    ] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const sourceSelect = container.querySelector('.pl-shared-family-photo select');
  await act(async () => {
    sourceSelect.value = '8626000775.jpg';
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const codes = container.querySelector('.pl-shared-family-photo input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(codes,
      '8626000775B, 8626000775H, 8626000775M, 8626000775P, 8626000775U');
    codes.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent === 'Check and stage these variants').click());
  expect(lookupFilenames).toHaveBeenCalledTimes(2);
  expect(lookupFilenames.mock.calls[1][0]).toEqual(['B', 'H', 'M', 'P', 'U'].map((suffix) => `8626000775${suffix}.jpg`));
  expect(container.querySelectorAll('.pl-landed-panel [role="listitem"]')).toHaveLength(6);
  expect(container.textContent).toContain('Shared main photo: 8626000775.jpg');
  expect(container.textContent).toContain('8626000775-1.jpg');
});
