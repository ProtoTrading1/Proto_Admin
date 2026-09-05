import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isExistingExcelArchiveRow,
  matchVariantImages,
  parseVariantRows,
  variantRowState,
} from '../src/lib/productVariantImport.js';

const ROOT = resolve(import.meta.dirname, '..');
const image = (name) => ({ name, type: 'image/jpeg' });

describe('Excel + local image variant import', () => {
  it('preserves the barcode column, including shared barcodes across SKUs', () => {
    expect(parseVariantRows([
      ['SKU', 'Barcode', 'Description'],
      ['MUG514-BLK', '8626000514', 'Black mug'],
      ['MUG514-WHT', '8626000514', 'White mug'],
    ])).toEqual([
      { sku: 'MUG514-BLK', barcode: '8626000514', title: 'Black mug' },
      { sku: 'MUG514-WHT', barcode: '8626000514', title: 'White mug' },
    ]);
  });
  it('keeps different SKUs and titles separate when they share one barcode', () => {
    const rows = [
      { sku: 'MUG514-BLK', barcode: '8626000514', title: 'Black mug' },
      { sku: 'MUG514-WHT', barcode: '8626000514', title: 'White mug' },
    ];
    const result = matchVariantImages(rows, [
      image('MUG514-BLK.jpg'), image('MUG514-BLK.2.jpg'), image('MUG514-WHT.jpg'),
    ]);
    expect(result.items[0]).toMatchObject({ sku: 'MUG514-BLK', title: 'Black mug', hasPrimaryImage: true });
    expect(result.items[0].images.map((entry) => entry.slot)).toEqual([1, 2]);
    expect(result.items[1]).toMatchObject({ sku: 'MUG514-WHT', title: 'White mug', hasPrimaryImage: true });
    expect(result.items[1].images.map((entry) => entry.slot)).toEqual([1]);
  });

  it('never fuzzy-matches an unrelated filename', () => {
    const result = matchVariantImages(
      [{ sku: 'MUG514-BLK', barcode: '8626000514', title: 'Black mug' }],
      [image('MUG514.jpg'), image('MUG514-BLACK.jpg')],
    );
    expect(result.items[0].images).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('blocks existing SKUs, duplicate slots and rows without a main image', () => {
    expect(variantRowState({ existing: true }).ready).toBe(false);
    expect(variantRowState({ sourceFound: true, price: 10, hasPrimaryImage: false }).ready).toBe(false);
    expect(variantRowState({ sourceFound: true, price: 10, hasPrimaryImage: true, duplicateSlots: [{ slot: 1 }] }).ready).toBe(false);
    expect(variantRowState({ sourceFound: true, price: 10, hasPrimaryImage: true, duplicateSlots: [] })).toEqual({ ready: true, reason: 'Ready' });
  });

  it('can include an earlier Excel Archive row without replacing its images', () => {
    const row = {
      existing: true,
      existingLocation: 'archive',
      archivedBy: 'excel-images:previous-batch',
      hasPrimaryImage: false,
    };
    expect(isExistingExcelArchiveRow(row)).toBe(true);
    expect(variantRowState(row)).toMatchObject({ ready: true });
    expect(isExistingExcelArchiveRow({ ...row, archivedBy: 'manual' })).toBe(false);
    const previewEndpoint = readFileSync(resolve(ROOT, 'api/product-loader-variant-preview.js'), 'utf8');
    const archiveEndpoint = readFileSync(resolve(ROOT, 'api/product-loader-variant-archive.js'), 'utf8');
    expect(previewEndpoint).toContain("select('sku, title, barcode, archived_by')");
    expect(previewEndpoint).toContain('archivedBy:');
    expect(archiveEndpoint).toContain('!includeExistingInBatch && !imageFields.image_url_one');
    expect(archiveEndpoint).toContain('archived.archived_by === archivedBy');
  });

  it('protects existing website and Archive SKUs before storage upload', () => {
    const client = readFileSync(resolve(ROOT, 'src/lib/productLoaderApi.js'), 'utf8');
    const endpoint = readFileSync(resolve(ROOT, 'api/upload-product-image.js'), 'utf8');
    expect(client).toContain('requireNew = false');
    expect(endpoint).toContain(".from('website_stock')");
    expect(endpoint).toContain(".from('archived_products')");
    expect(endpoint).toContain("code: 'exists'");
    expect(endpoint).toContain('upsert: Boolean(safeSku)');
  });

  it('stages the batch in Archive with category selection removed from intake', () => {
    const component = readFileSync(resolve(ROOT, 'src/components/productLoader/ProductLoaderVariantImport.jsx'), 'utf8');
    const archiveEndpoint = readFileSync(resolve(ROOT, 'api/product-loader-variant-archive.js'), 'utf8');
    const catalogueEndpoint = readFileSync(resolve(ROOT, 'api/catalog.js'), 'utf8');
    expect(component).toContain('`Send ${pendingRows.length} to Archive`');
    expect(component).not.toContain('CategoryPathSelect');
    expect(component).not.toContain('Create {readyRows.length} new products');
    expect(archiveEndpoint).toContain('excelImageArchiveSource(body.batchId)');
    expect(archiveEndpoint).toContain("category: 'Uncategorised'");
    expect(archiveEndpoint).toContain("subcategory_one: 'General'");
    expect(catalogueEndpoint).toContain('isExcelImageArchiveSource(r.archived_by)');
  });

  it('continues after row failures and keeps successful rows out of retries', () => {
    const component = readFileSync(resolve(ROOT, 'src/components/productLoader/ProductLoaderVariantImport.jsx'), 'utf8');
    const client = readFileSync(resolve(ROOT, 'src/lib/productLoaderApi.js'), 'utf8');
    expect(component).toContain("status: 'failed'");
    expect(component).toContain("status !== 'success'");
    expect(component).toContain('for (let index = 0; index < pendingRows.length; index += 1)');
    expect(component).toContain("const batchId = batchIdRef.current");
    expect(component).toContain("batchIdRef.current = globalThis.crypto?.randomUUID?.()");
    expect(component).toContain('includeExistingInBatch');
    expect(component).toContain('uploadedImagesRef.current');
    expect(component).toContain("localStorage.setItem('proto-catalog-mutated-at'");
    expect(client).toContain('batchId,');
    expect(client).toContain('includeExistingInBatch,');
  });
});
