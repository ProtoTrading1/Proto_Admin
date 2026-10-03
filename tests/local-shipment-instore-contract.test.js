import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { receivedInvoiceLinesToSellable, receivedPiecesToSellable } from '../lib/received-stock-unit.mjs';
import { inferExplicitPiecePackFromDescription } from '../lib/selling-unit.mjs';
import { mergeReceivedStockSheets } from '../src/lib/instoreShipmentSheet.js';

const lookup = readFileSync(new URL('../api/_product-loader-lookup.js', import.meta.url), 'utf8');
const batchLookup = readFileSync(new URL('../api/product-loader-batch-lookup.js', import.meta.url), 'utf8');
const upload = readFileSync(new URL('../src/components/productLoader/ProductLoaderUpload.jsx', import.meta.url), 'utf8');
const review = readFileSync(new URL('../src/components/productLoader/InstoreReview.jsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/lib/productLoaderApi.js', import.meta.url), 'utf8');
const receiptSheet = readFileSync(new URL('../src/lib/instoreShipmentSheet.js', import.meta.url), 'utf8');
const importRoute = readFileSync(new URL('../api/nutstore-process.js', import.meta.url), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('landed shipment → Instore-only safety contract', () => {
  it('keeps Stock Received files selected one after another and refuses double-loading', () => {
    const first = {
      quantities: new Map([['8616500371', 10]]),
      receiptLines: new Map([['8616500371', [{ qty: 10, unit: 'PCS' }]]]),
      sellingUnits: new Map(), duplicates: [], invalid: [], unitConflicts: [],
      quantityFiles: ['first.xlsx'], departmentFiles: [], filename: 'first.xlsx',
    };
    const second = {
      quantities: new Map([['8616500371', 5], ['8616500414', 20]]),
      receiptLines: new Map([
        ['8616500371', [{ qty: 5, unit: 'PCS' }]],
        ['8616500414', [{ qty: 20, unit: 'PCS' }]],
      ]),
      sellingUnits: new Map(), duplicates: [], invalid: [], unitConflicts: [],
      quantityFiles: ['second.xlsx'], departmentFiles: [], filename: 'second.xlsx',
    };

    const merged = mergeReceivedStockSheets(first, second);
    expect(merged.quantities.get('8616500371')).toBe(15);
    expect(merged.quantities.get('8616500414')).toBe(20);
    expect(merged.receiptLines.get('8616500371')).toEqual([{ qty: 15, unit: 'PCS' }]);
    expect(merged.quantityFiles).toEqual(['first.xlsx', 'second.xlsx']);
    expect(merged.duplicates).toContain('8616500371');
    expect(() => mergeReceivedStockSheets(merged, second)).toThrow(/Already loaded: second\.xlsx/);
  });

  it('uses only an exact live Positill row for a strict landed-shipment lookup', () => {
    const strictLookup = functionBody(lookup, 'lookupPositillStrict');

    expect(strictLookup).toContain("resolved.dataSource === 'erp_sql' && resolved.product");
    expect(strictLookup).toContain("matchedBy: 'positill_code'");
    expect(strictLookup).not.toContain('stmast_cache');
    expect(strictLookup).not.toContain('ilike(');
  });

  it('requires the Instore-only screen to request strict lookup and use the positive receipt quantity', () => {
    expect(upload).toContain('instoreOnly');
    expect(upload).toMatch(/strictExact\s*:\s*instoreOnly/);
    expect(upload).toContain('parseReceivedStockSheet');
    expect(upload).toContain('importLocalShipmentToInstore');
    expect(upload).toContain('receivedQty');
    expect(api).toContain("action: stockMode === 'positill_live' ? 'instore_live' : 'instore'");
    expect(api).toMatch(/items:\s*\[\{[\s\S]*receiptLines/);
  });

  it('allows a positive received quantity to cover a zero current stock warning, but blocks unsafe product data', () => {
    expect(receiptSheet).toContain('qty >= 1');
    expect(receiptSheet).toContain('No positive received quantities were found');

    const blockerStart = upload.indexOf('const INSTORE_LIVE_POSITILL_BLOCKERS');
    const blockerEnd = upload.indexOf('function canImportToInstore', blockerStart);
    const instoreBlockers = upload.slice(blockerStart, blockerEnd);
    const eligibility = functionBody(upload, 'canImportToInstore');
    expect(eligibility).toContain('allowedWarnings.has(warning)');
    expect(eligibility).toContain("row.positillSource === 'erp_sql'");
    expect(eligibility).not.toContain('!row.websiteRow');
    expect(upload).toContain('function instoreSelectionBlocker');
    expect(upload).toContain('instoreDuplicateBlocker');
    expect(upload).toContain('No positive received quantity was found for this SKU in the Stock Received Excel.');
    for (const warning of ['not_in_catalog', 'price_zero', 'price_source_cached', 'price_suspect_ex_vat']) {
      expect(instoreBlockers).toContain(warning);
    }
    expect(instoreBlockers).not.toContain('low_stock');
  });

  it('blocks an exact SKU or barcode already on the main site before adding to Instore', () => {
    const importStart = importRoute.indexOf('async function importInstoreOne');
    const importEnd = importRoute.indexOf('async function reconcileInstoreLandedStock', importStart);
    const importOne = importRoute.slice(importStart, importEnd);

    expect(importOne).toContain("sb.from('website_stock').select('sku').eq('sku', sku).maybeSingle()");
    expect(importOne).toContain("sb.from('website_stock').select('sku').eq('barcode', sku).limit(1).maybeSingle()");
    expect(importOne).toMatch(/from\('extended_range_items'\)\.select\('sku'\)\.eq\('sku', sku\)\.maybeSingle\(\)/);
    expect(importOne).toContain('already in Instore; edit it there instead');
    expect(importOne).not.toMatch(/from\('website_stock'\)\.(?:insert|update|delete)/);
  });

  it('fails closed unless the production-only import mode is explicitly enabled', () => {
    expect(importRoute).toContain("action === 'instore'");
    expect(importRoute).toContain('INSTORE_LANDED_IMPORT_MODE');
    expect(importRoute).toContain("'production-enabled'");
    expect(importRoute).toContain('scoped to Vercel Production only');
    expect(review).toContain('Test preview — adding products is disabled');
    expect(upload).toContain('!instoreImportEnabled');
  });

  it('writes the same VAT-inclusive price and uses the canonical selling unit for quantity conversion', () => {
    expect(importRoute).toContain('customerPriceFromPositill(source?.price)');
    expect(importRoute).toContain('receivedInvoiceLinesToSellable');
    expect(importRoute).toContain('available_stock: sellableQty');
    expect(importRoute).toContain('catalogueDisplayTitle(sourceItem)');
    expect(importRoute).toContain('catalogueDescription(sourceItem)');
    expect(importRoute).toContain('fetchCanonicalUnitMeta');
    expect(importRoute).toContain("stock.from('extended_range_items').select(INSTORE_WRITE_COLUMNS).limit(0)");
  });

  it('normalises new Instore descriptions to uppercase without changing the live Positill lookup', () => {
    const importStart = importRoute.indexOf('async function importInstoreOne');
    const importEnd = importRoute.indexOf('async function reconcileInstoreLandedStock', importStart);
    const importOne = importRoute.slice(importStart, importEnd);

    expect(importOne).toContain('const title = catalogueDisplayTitle(sourceItem).toUpperCase();');
    expect(importOne).toContain('const description = catalogueDescription(sourceItem).toUpperCase();');
    expect(importOne).toContain('title,');
    expect(importOne).toContain('original_description: websiteCopy.description,');
    expect(importOne).toContain('title: websiteCopy.title,');
    expect(importOne).toContain('normalizeInstoreCopy(item.websiteCopy)');
  });

  it('does not require optional unit metadata columns in the legacy Instore table', () => {
    const insertStart = importRoute.indexOf('const instoreInsert = {');
    const insertEnd = importRoute.indexOf(".from('extended_range_items').insert(instoreInsert)", insertStart);
    const insertPayload = importRoute.slice(insertStart, insertEnd);

    expect(insertPayload).not.toContain('units_of_issue: unitsOfIssue');
    expect(insertPayload).not.toContain('pack_description:');
  });

  it('uses the only image source accepted by the live Instore schema while retaining shipment provenance separately', () => {
    const insertStart = importRoute.indexOf('const instoreInsert = {');
    const insertEnd = importRoute.indexOf(".from('extended_range_items').insert(instoreInsert)", insertStart);
    const insertPayload = importRoute.slice(insertStart, insertEnd);

    expect(insertPayload).toContain("image_source: 'nutstore'");
    expect(insertPayload).toContain('image_source_key: sourceKey');
    expect(importRoute).toContain(".eq('image_source', 'nutstore')");
    expect(importRoute).not.toContain("image_source: 'local_folder'");
  });

  it('puts explicit batch category assignment before the product review list', () => {
    const categoryControl = review.indexOf('{categoryPicker}');
    const reviewList = review.indexOf('className="ir-products"');
    expect(categoryControl).toBeGreaterThan(-1);
    expect(categoryControl).toBeLessThan(reviewList);
    expect(upload).toContain('mainLabel="Assign Instore category"');
    expect(review).toContain('Assign category to selected');
    expect(upload).toContain('instoreCategoryAssignmentBlocker');
  });

  it('explains a disabled import and counts the same exact SKUs that the import will process', () => {
    expect(upload).toContain('function instoreImportBlockReason');
    expect(upload).toContain('selectedInstoreSkuCount');
    expect(upload).toContain('const selectedInstoreSkuCount = selectedInstoreEntries.length;');
    expect(upload).toContain('buildInstoreReview(shipmentItems');
    expect(upload).toContain('uniqueInstoreRows');
    expect(upload).toContain('instoreDestinationIds');
    expect(upload).toContain('row.instoreCategoryPath');
    expect(review).toContain('Select reviewable products in these results');
    expect(importRoute).toContain('instoreCategoryAssignmentBlocker');
    expect(review).toContain('Review and add to Instore');
    expect(review).toContain('{disabledReason}');
  });

  it('explains the exact prerequisite when the Instore import action is disabled', () => {
    expect(upload).toContain('function instoreImportBlockReason');
    expect(upload).toContain('Choose the Stock Received Excel to load confirmed quantities.');
    expect(upload).toContain('Resolve the selected products that need attention before adding.');
    expect(upload).toContain('Select at least one eligible SKU to import.');
    expect(review).toContain('{disabledReason}');
    expect(review).toContain('disabled={busy || Boolean(disabledReason)}');
    expect(upload).toContain('canSelectForInstore(row, receiptLines, row.instoreCategoryPath, instoreStockMode)');
  });

  it('converts received pieces to the available selling-unit rule', () => {
    expect(receivedInvoiceLinesToSellable([{ qty: 505, unit: 'PCS' }], 'PACK 100')).toMatchObject({
      receivedQty: 505,
      unitSize: 100,
      sellableQty: 5,
      remainder: 5,
    });
    expect(receivedPiecesToSellable(505, 'PACK 100')).toMatchObject({
      receivedQty: 505,
      unitsOfIssue: 'PACK 100',
      unitSize: 100,
      sellableQty: 5,
      remainder: 5,
    });
    expect(receivedPiecesToSellable(505, 'EACH')).toMatchObject({
      receivedQty: 505,
      sellableQty: 505,
      unitSize: 1,
    });
    expect(importRoute).not.toContain("explicitDescriptionUnit || 'EACH'");
    expect(importRoute).toContain('no verified canonical selling unit');
    expect(importRoute).toContain("? 'positill_live'");
    expect(importRoute).toContain("? 'positill_product'");
  });

  it('uses Positill UNITS ahead of every mirrored selling-unit fallback', () => {
    const stmast = readFileSync(new URL('../api/_sql-stmast.js', import.meta.url), 'utf8');

    expect(stmast).toContain('CODE, DESCR, UNITS, PRICE_A');
    expect(stmast).toContain('units_of_issue: String(sqlRow.UNITS ?? \'\').trim()');
    expect(lookup).toContain('sqlRow?.units_of_issue || productRow?.units_of_issue');
    expect(importRoute).toContain("const positillUnits = String(source?.units_of_issue || '').trim()");
  });

  it('does not hide the existing backend unit when optional pack metadata is absent', () => {
    expect(lookup).toContain("'sku, sell_price, units_of_issue'");
    expect(lookup).not.toContain("'sku, sell_price, units_of_issue, pack_description'");
    expect(importRoute).toContain(".select('sku,units_of_issue')");
    expect(importRoute).toContain(".select('pack_description')");
  });

  it('does not gate a Positill-backed import on the optional products mirror', () => {
    const statusStart = importRoute.indexOf("if (req.method === 'GET')");
    const statusEnd = importRoute.indexOf("if (req.method !== 'POST')", statusStart);
    const statusRoute = importRoute.slice(statusStart, statusEnd);
    expect(statusRoute).toContain("stock.from('extended_range_items').select(INSTORE_WRITE_COLUMNS).limit(0)");
    expect(statusRoute).not.toContain("stock.from('products').select('sku').limit(0)");

    const importStart = importRoute.indexOf('async function importInstoreOne');
    const importEnd = importRoute.indexOf('async function reconcileInstoreLandedStock', importStart);
    const importOne = importRoute.slice(importStart, importEnd);
    expect(importOne).toContain('const canonicalProduct = (positillUnits || liveStock) ? null : await fetchCanonicalUnitMeta(sb, sku);');
  });

  it('fails closed when a landed SKU has no verified selling unit', () => {
    expect(importRoute).toContain('const rawUnitsOfIssue = positillUnits || mirroredUnits || explicitDescriptionUnit || departmentInvoiceUnit || adminConfirmedGiftBagUnit || adminConfirmedBatchUnit;');
    expect(importRoute).toContain('if (!rawUnitsOfIssue && receipt.receivedPieces)');
    expect(importRoute).toContain('no verified canonical selling unit');
    expect(batchLookup).toContain("'selling_unit_required'");
    expect(lookup).toContain(": (strictExact ? '' : 'EACH')");

    const blockerStart = upload.indexOf('const INSTORE_LIVE_POSITILL_BLOCKERS');
    const blockerEnd = upload.indexOf('function canImportToInstore', blockerStart);
    expect(upload.slice(blockerStart, blockerEnd)).toContain("'selling_unit_required'");
    expect(upload).toContain('const { unitsOfIssue: unit, unitSize, sellableQty, remainder } = conversion;');
    expect(upload).toContain('Selling quantity needs verification');
    expect(upload).toContain('receivedInvoiceLabel(receipt)');
    expect(upload).toContain('receiptLines?.get');
  });

  it('accepts a Positill department-invoice unit, but never a supplier PCS column, while the live bridge is pending', () => {
    expect(receiptSheet).toContain('departmentColumn >= 0');
    expect(receiptSheet).toContain('if (qtyColumn >= 0)');
    expect(receiptSheet).toContain('sellingUnits');
    expect(upload).toContain('applyPositillDepartmentUnits');
    expect(api).toContain("verifiedSellingUnitSource: item.sellingUnitSource === 'positill_department_invoice'");
    expect(importRoute).toContain("item?.verifiedSellingUnitSource === 'positill_department_invoice'");
    expect(importRoute).toContain('departmentInvoiceUnit');
    expect(upload).toContain('Add Positill unit invoice');
    expect(upload).toContain('parseReceivedStockSheet(fileList, { requireQuantities: false })');
    expect(receiptSheet).toContain('{ requireQuantities = true }');
  });

  it('supports an explicit, resettable batch EACH confirmation without changing Positill', () => {
    expect(upload).toContain('Confirm selected PCS items are EACH for this shipment');
    expect(upload).toContain('setConfirmSelectedPcsEach(false)');
    expect(upload).toContain('setConfirmSelectedPcsEach(event.target.checked)');
    expect(upload).toContain('confirmSelectedPcsEach && instoreSelected.has(row.filename)');
    expect(upload).toContain('applyAdminConfirmedBatchEach');
    expect(api).toContain("'admin_confirmed_batch_each'");
    expect(importRoute).toContain("item?.adminConfirmedSellingUnitSource === 'admin_confirmed_batch_each'");
    expect(importRoute).toContain('isAdminConfirmedBatchEach');
  });

  it('does not bring back a desktop companion or a test-database write exception', () => {
    const touchedFlow = [upload, api, importRoute, receiptSheet].join('\n');
    for (const forbidden of [
      'proto-instore-companion',
      'requestDesktopShipmentStage',
      'local-shipment-stage',
      'TEST_PROJECT_REF',
      'INSTORE_ADMIN_TEST_WRITES',
    ]) {
      expect(touchedFlow).not.toContain(forbidden);
    }
  });

  it('keeps landed-shipment state isolated from the normal multiple-image draft', () => {
    expect(upload).toContain('instoreOnly ? null : getProductLoaderUploadDraftRecovery()');
    expect(upload).toContain('if (!instoreOnly) {');
    expect(upload).toContain('if (instoreOnly) return;');
    expect(upload).toContain('if (!instoreOnly) clearProductLoaderUploadDraft();');
  });
});

it('uses an explicit Positill piece-count description only as a safe pack fallback', () => {
  expect(inferExplicitPiecePackFromDescription('BRASS BALL PIN +-100PCS')).toBe('PACK 100');
  expect(inferExplicitPiecePackFromDescription('METAL CHARM QTY: 10 PCS')).toBe('PACK 10');
  expect(inferExplicitPiecePackFromDescription('JUMP RING +-10g')).toBe('');
  expect(inferExplicitPiecePackFromDescription('METAL CHARM +-5PCS')).toBe('PACK 5');
});
