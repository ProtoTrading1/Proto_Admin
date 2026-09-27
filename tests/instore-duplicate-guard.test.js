import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  instoreDuplicateBlocker,
  mainSiteInstoreCodeSet,
  normalizeInstoreSku,
} from '../lib/instore-duplicate-guard.mjs';

describe('landed Instore duplicate guard', () => {
  it('blocks a SKU already live on the main website', () => {
    expect(instoreDuplicateBlocker({ websiteStatus: 'live' })).toMatch(/Already on the main website/);
    expect(instoreDuplicateBlocker({ existingOnMainSite: true })).toMatch(/Already on the main website/);
  });

  it('fails closed when the exact main-site catalogue lookup fails', () => {
    expect(instoreDuplicateBlocker({ existingMainSiteLookupFailed: true })).toMatch(/Could not verify the main website catalogue/);
  });

  it('blocks a SKU already in Instore and permits a genuinely new SKU', () => {
    expect(instoreDuplicateBlocker({ existingInstore: true })).toMatch(/Already in Instore/);
    expect(instoreDuplicateBlocker({ websiteStatus: 'new', existingInstore: false })).toBe('');
  });

  it('fails closed when the Instore duplicate lookup fails', () => {
    expect(instoreDuplicateBlocker({ existingInstoreLookupFailed: true })).toMatch(/Could not verify Instore status/);
  });

  it('uses a normalized exact SKU key for duplicate checks', () => {
    expect(normalizeInstoreSku(' 8621100236 ')).toBe('8621100236');
  });

  it('recognizes an incoming code stored as the live product barcode under a suffixed SKU', () => {
    const incomingCode = normalizeInstoreSku('8621100236');
    const liveProduct = { sku: '8621100236-IVR', barcode: '8621100236' };
    const matchedCodes = mainSiteInstoreCodeSet([liveProduct]);

    expect(matchedCodes.has(incomingCode)).toBe(true);
  });

  it('checks the main catalogue before the importer can upload an image', () => {
    const importer = readFileSync(new URL('../api/nutstore-process.js', import.meta.url), 'utf8');
    const mainSiteSkuCheck = importer.indexOf(".from('website_stock').select('sku').eq('sku', sku).maybeSingle()");
    const mainSiteBarcodeCheck = importer.indexOf(".from('website_stock').select('sku').eq('barcode', sku).limit(1).maybeSingle()");
    const imageDecode = importer.indexOf('const { buffer, filename, contentType } = decodeLocalImage(item, sku);');

    expect(mainSiteSkuCheck).toBeGreaterThan(-1);
    expect(mainSiteBarcodeCheck).toBeGreaterThan(-1);
    expect(imageDecode).toBeGreaterThan(mainSiteSkuCheck);
    expect(imageDecode).toBeGreaterThan(mainSiteBarcodeCheck);
  });

  it('applies the same duplicate rule in the landed-shipment selector', () => {
    const reviewUi = readFileSync(new URL('../src/components/productLoader/ProductLoaderUpload.jsx', import.meta.url), 'utf8');
    const batchLookup = readFileSync(new URL('../api/product-loader-batch-lookup.js', import.meta.url), 'utf8');

    expect(reviewUi).toContain('instoreDuplicateBlocker({');
    expect(batchLookup).toContain("lookupRowsInChunks(sb, 'website_stock', 'sku, barcode', 'sku', itemSkus)");
    expect(batchLookup).toContain("lookupRowsInChunks(sb, 'website_stock', 'sku, barcode', 'barcode', itemSkus)");
    expect(batchLookup).toContain('item.existingOnMainSite = existingMainSiteCodes.has');
    expect(batchLookup).toContain("lookupRowsInChunks(sb, 'extended_range_items', 'sku', 'sku', itemSkus)");
    expect(batchLookup).toContain('.in(field, values.slice(from, from + 100))');
  });
});
