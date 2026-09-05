#!/usr/bin/env node
/**
 * Smoke checks for post-PR#55 QA (no auth required for pure logic tests).
 * Run: node scripts/qa-smoke-check.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderMatchesTab, isOrderConfirmationSent } from '../src/lib/orderStatus.js';
import { parseOrderTab, parsePositiveInt, parseBusinessTypeFilter } from '../api/_admin-query-params.js';
import {
  deriveMotarroPathFromLabels,
  inferMotarroPathFromRow,
  injectMotarroIntoTree,
  motarroPathSnapshot,
  parseStoredMotarroPath,
} from '../lib/mottaro-category.mjs';
import { matchesTaxonomyLabel, normalizeLabel, rowMatchesLabelScope, escapeIlikePattern, parseExtraLabels } from '../lib/taxonomy-match.mjs';
import { buildClearLabelsPatch, buildNodeProductFilter, labelsToDbFields, nodeScopeColumn, resolveCategoryIds } from '../api/_taxonomy-utils.js';
import { resolveCategoryFilters, applyCategoryFiltersToQuery, filterByCategoryPath, categoryPathExceedsFixedColumns, adaptCatalogRow } from '../api/_catalog-adapt.js';
import { BULK_CHUNK_SIZE, MOVE_UPDATE_CHUNK_SIZE, runInChunks } from '../lib/bulk-chunk.mjs';
import { codeLookupCandidates, firstCodeToken } from '../lib/code-normalize.mjs';
import { catalogueDisplayTitle, catalogueDescription, loaderCodeLabel } from '../lib/product-loader-display.mjs';
import { parseNutstoreFilename } from '../api/_nutstore-filename.js';
import { resolveProductLoaderMatch } from '../api/_product-loader-lookup.js';
import {
  buildTradeApplicationEmail,
  tradeApplicationGreetingName,
} from '../lib/trade-application-email.mjs';
import { parseIntakeFilename } from '../src/lib/parseIntakeFilename.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (relPath) => readFileSync(join(REPO_ROOT, relPath), 'utf8');

console.log('QA smoke checks…\n');

// B1 — Mottaro inject
const tree = injectMotarroIntoTree([
  { id: 'arts-and-crafts', label: 'Arts and Crafts', children: [] },
  { id: 'stationery', label: 'Stationery', children: [] },
]);
assert.ok(tree.some((n) => n.id === 'mottaro'), 'Mottaro node present after inject');
const tree2 = injectMotarroIntoTree(tree);
assert.equal(tree2.filter((n) => n.id === 'mottaro').length, 1, 'No double-inject');
console.log('✓ B1 Mottaro inject');

// D4 — order tab bucketing with confirmation_sent_at
const orderSent = { id: '1', status: 'order sent', confirmation_sent_at: null };
const orderSentConfirmed = { id: '2', status: 'order sent', confirmation_sent_at: '2026-01-01T00:00:00Z' };
assert.equal(orderMatchesTab(orderSent, 'sent', {}), true);
assert.equal(orderMatchesTab(orderSentConfirmed, 'sent', {}), false);
assert.equal(orderMatchesTab(orderSentConfirmed, 'paid', {}), true);
assert.equal(isOrderConfirmationSent(orderSentConfirmed), true);
console.log('✓ D4 confirmation_sent_at tab bucketing');

// QA-3 — query param validation
assert.throws(() => parseOrderTab('bogus'), /Invalid tab/);
assert.throws(() => parsePositiveInt('abc', { name: 'page' }), /Invalid page/);
assert.equal(parseBusinessTypeFilter('__unspecified__'), '__unspecified__');
console.log('✓ Query param validation');

// Item 1 — stale sections removed + bulk chunk helpers
const adminPageSrc = readSrc('src/pages/AdminPage.jsx');
assert.doesNotMatch(adminPageSrc, /false\s*&&\s*activeSection/, 'No dead false&& section guards in AdminPage');
assert.doesNotMatch(adminPageSrc, /activeSection\s*===\s*'dormant-products'/, 'No dormant-products section');
console.log('✓ Item 1 stale AdminPage sections removed');

const bulkSrc = readSrc('api/bulk-products.js');
assert.match(bulkSrc, /bulkDeleteProducts/, 'batched delete helper present');
assert.match(bulkSrc, /bulkMoveProducts/, 'batched move helper present');
assert.match(bulkSrc, /runInChunks/, 'chunked archive/unarchive');
assert.match(bulkSrc, /chunkedInUpdate/, 'bulkMoveProducts chunks UPDATE batches');
assert.match(bulkSrc, /chunkedInDelete/, 'bulkDeleteProducts chunks DELETE batches');
assert.match(bulkSrc, /MOVE_UPDATE_CHUNK_SIZE/, 'bulk move/delete use MOVE_UPDATE_CHUNK_SIZE');

let chunkSum = 0;
await runInChunks([1, 2, 3, 4, 5], 2, async (n) => { chunkSum += n; return n; });
assert.equal(chunkSum, 15, 'runInChunks runs all items');
assert.equal(BULK_CHUNK_SIZE, 25, 'chunk size is 25');
assert.equal(MOVE_UPDATE_CHUNK_SIZE, 100, 'move update chunk size is 100');
console.log('✓ Item 1 bulk-products batched + chunked');

const taxonomyUtilsSrc = readSrc('api/_taxonomy-utils.js');
assert.match(taxonomyUtilsSrc, /expectedUpdatedAt/, 'taxonomy save checks expectedUpdatedAt');
assert.match(taxonomyUtilsSrc, /c\.id !== 'mottaro'/, 'taxonomy save still strips mottaro');
const taxonomyAdminSrc = readSrc('src/lib/taxonomyAdmin.js');
assert.match(taxonomyAdminSrc, /err\.status = 409/, 'taxonomy client handles 409');
console.log('✓ Item 2 taxonomy optimistic locking');

const approveSrc = readSrc('api/approve-customers-bulk.js');
assert.match(approveSrc, /fetchCustomersByEmails/, 'bulk approve batches customer lookup');
assert.match(approveSrc, /runInChunks/, 'bulk approve uses chunked parallelism');
console.log('✓ Item 3 bulk customer approve batched');

// Archive/Nutstore correctness — API contract
const catalogSrc = readSrc('api/catalog.js');
assert.match(catalogSrc, /r\.stockLinked === false/, 'archive filter respects stockLinked=false (item 2)');
assert.match(catalogSrc, /r\.archived_by === 'nutstore'/, 'archive filter keeps nutstore rows visible (item 2)');
assert.match(catalogSrc, /applyCategoryFiltersToQuery\(q, resolveCategoryFilters\(tree, categoryPath\)\)/, 'archive fetch applies category filter (item 7)');
console.log('✓ Item 2 archive Nutstore visibility + category filter');

const stockSrc = readSrc('api/_stock-client.js');
assert.match(stockSrc, /stockLinked: false/, 'enrichRowsWithProductStock exposes stockLinked=false when no ERP row');
assert.doesNotMatch(stockSrc, /available_stock: r\.available_stock \?\? r\.stock_qty \?\? 0/, 'stock enrichment no longer coerces missing ERP stock to 0');
console.log('✓ Item 2 stock enrichment preserves unknown stock');

// Nutstore hardening — parallelism, cache, dedup
const vercelJson = JSON.parse(readSrc('vercel.json'));
assert.equal(vercelJson.functions?.['api/nutstore-batch-lookup.js']?.maxDuration, 30, 'nutstore-batch-lookup has 30s timeout');
assert.equal(vercelJson.functions?.['api/nutstore-process.js']?.maxDuration, 60, 'nutstore-process has 60s timeout');
const nutstoreProcessSrc = readSrc('api/nutstore-process.js');
assert.match(nutstoreProcessSrc, /NUTSTORE_CONCURRENCY = 4/, 'nutstore-process uses concurrency of 4');
assert.doesNotMatch(nutstoreProcessSrc, /for \(const raw of items\)/, 'nutstore-process no longer sequential');
assert.match(nutstoreProcessSrc, /catalogueDisplayTitle/, 'nutstore-process resolves title via shared helper');
assert.match(nutstoreProcessSrc, /catalogueDescription/, 'nutstore-process resolves description via shared helper');
assert.doesNotMatch(nutstoreProcessSrc, /item\.sqlRow\?\.title \|\| item\.websiteRow/, 'nutstore-process no raw sqlRow title fallback');
const nutstoreLookupSrc = readSrc('api/_product-loader-lookup.js');
assert.match(nutstoreLookupSrc, /getCachedDormantSkuSet/, 'dormant SKU set cached');
const nutstoreBatchSrc = readSrc('api/nutstore-batch-lookup.js');
assert.match(nutstoreBatchSrc, /codeGroups/, 'nutstore batch lookup dedups by code');
assert.match(nutstoreBatchSrc, /displayCode \|\| parsed\.code/, 'nutstore batch dedups by filename stem');
assert.match(nutstoreBatchSrc, /code: displayCode/, 'nutstore batch passes full stem to resolveProductLoaderMatch');
console.log('✓ Item 3 Nutstore hardening (timeouts, parallelism, dedup, cache)');

// Nutstore relink on SKU/barcode edit
const updateProductSrc = readSrc('api/update-product.js');
assert.match(updateProductSrc, /verified\.archived_by === 'nutstore'/, 'update-product re-runs ERP lookup on Nutstore-archived rows');
assert.match(updateProductSrc, /resolveProductLoaderMatch/, 'update-product imports resolveProductLoaderMatch');
// Changing the code on ANY archived row lacking stock/price re-runs the Positill lookup
assert.match(updateProductSrc, /const lacksErpData =/, 'update-product detects archived rows with no ERP data');
assert.match(updateProductSrc, /verified\.archived_by === 'nutstore' \|\| lacksErpData/, 'relink runs for nutstore OR any archived row that needs SOH/price');
// Archived edits never send a category path (selectors are hidden; set at Make live)
assert.match(readSrc('src/pages/AdminPage.jsx'), /const sendCategory = categoryPath\.length > 0 && !editingProduct\?\.archivedBy/, 'archived product edits do not resend a (synthetic) category path');
// Folder publish/archive run with bounded concurrency instead of one-at-a-time
const plFolderSrc = readSrc('src/components/productLoader/ProductLoaderFolder.jsx');
assert.match(plFolderSrc, /async function runWithConcurrency/, 'folder loader has a bounded-concurrency runner');
assert.equal((plFolderSrc.match(/runWithConcurrency\(/g) || []).length, 3, 'runWithConcurrency defined once and used by both publish + archive');
assert.doesNotMatch(plFolderSrc, /for \(let idx = 0; idx < ready\.length/, 'folder publish no longer processes one image at a time');
assert.doesNotMatch(plFolderSrc, /for \(let idx = 0; idx < rows\.length/, 'folder archive no longer processes one image at a time');
assert.equal(
  spawnSync('node', ['--check', join(REPO_ROOT, 'api/update-product.js')], { encoding: 'utf8' }).status,
  0,
  'update-product.js passes node --check (no syntax errors)',
);
const websiteStockLookup = updateProductSrc.match(/\.from\('website_stock'\)[\s\S]*?\.maybeSingle\(\)/)?.[0] || '';
assert.doesNotMatch(
  websiteStockLookup,
  /archived_by/,
  'website_stock pre-update lookup does not select archived_by',
);
console.log('✓ Item 4 Nutstore relink on SKU/barcode edit');

// Compound code normalization — shared lookup candidates
assert.deepEqual(codeLookupCandidates('abc123'), ['ABC123']);
assert.deepEqual(
  codeLookupCandidates('8636737332-8636737333'),
  ['8636737332-8636737333', '8636737332', '8636737333'],
);
// Tiny numeric fragments are deliberately dropped as lookup noise.
assert.deepEqual(codeLookupCandidates('ABC-2'), ['ABC-2', 'ABC']);
assert.deepEqual(
  codeLookupCandidates('sku1 / sku2 & sku3'),
  ['SKU1 / SKU2 & SKU3', 'SKU1', 'SKU2', 'SKU3'],
);
assert.deepEqual(codeLookupCandidates(''), []);
assert.equal(firstCodeToken('8636737332-8636737333'), '8636737332');
assert.equal(firstCodeToken('abc123'), 'ABC123');
assert.deepEqual(codeLookupCandidates('LSL36(2)'), ['LSL36(2)', 'LSL36'], 'a (2) copy marker falls back to the base code');
console.log('✓ Item 1 codeLookupCandidates + firstCodeToken');

// Folder-upload variant codes: "CODE(2)" / "CODE (2)" = same product, another
// variant — must resolve the base code and publish to a sibling SKU (CODE-2).
for (const name of ['LSL36(2).jpg', 'LSL36 (2).jpg']) {
  const v = parseIntakeFilename(name);
  assert.equal(v.sourceSku, 'LSL36', `${name} resolves the base code`);
  assert.equal(v.copyIndex, 2, `${name} is copy #2`);
}
assert.equal(parseIntakeFilename('LSL36.2.jpg').sourceSku, 'LSL36', 'dot slot resolves base code');
assert.equal(parseIntakeFilename('LSL36.2.jpg').imageNumber, 2, 'dot suffix is the image slot');
// The dash is NO LONGER a slot suffix — a code ending in "-2" is just a code.
assert.equal(parseIntakeFilename('LSL36-2.jpg').imageNumber, 1, 'dash suffix is no longer a slot');
assert.equal(parseIntakeFilename('LSL36-2.jpg').sourceSku, 'LSL36-2', 'dash stays part of the code');
// Exact-product-match-first: a real variant SKU ending in .2/.3/.4 keeps its
// slot suffix in fullCode so the resolver can prefer the real SKU over slot 2.
const mktVariant = parseIntakeFilename('MKT822662.2.jpg');
assert.equal(mktVariant.fullCode, 'MKT822662.2', 'fullCode keeps the .2 for exact-match-first');
assert.equal(mktVariant.sourceSku, 'MKT822662', 'stripped sourceSku drops the slot suffix');
assert.equal(mktVariant.imageNumber, 2, 'stripped slot is 2');
// ".1" is NEVER a slot suffix — a code ending in .1 is just a code.
assert.equal(parseIntakeFilename('CODE.1.jpg').imageNumber, 1, '.1 is not a slot');
assert.equal(parseIntakeFilename('CODE.1.jpg').sourceSku, 'CODE.1', '.1 stays part of the code');
const batchLookupSrc = readSrc('api/product-loader-batch-lookup.js');
assert.match(batchLookupSrc, /parsed\.copyIndex > 1 && \(match\.websiteRow \|\| match\.sqlRow\)/, 'batch lookup treats a resolved copy as a variant');
assert.match(batchLookupSrc, /code: siblingSku/, 'variant publishes to the sibling SKU (no parent overwrite)');
console.log('✓ Folder-upload copy variants pick up the base product');

const nutstoreParsed = parseNutstoreFilename('863673733-8636737332.jpg');
assert.equal(nutstoreParsed.code, '863673733');
assert.equal(parseNutstoreFilename('ABC-2.jpg').code, 'ABC');
console.log('✓ Item 3 Nutstore filename parser uses firstCodeToken');

const lookupTried = [];
const fakeSb = {
  from(table) {
    const query = { table, val: null };
    const api = {
      select: () => api,
      eq: (_col, val) => { query.val = val; return api; },
      ilike: () => api,
      limit: () => api,
      maybeSingle: async () => {
        lookupTried.push(query.val);
        if (table === 'website_stock' && query.val === '8636737332') {
          return {
            data: {
              sku: '8636737332',
              title: 'Compound fallback',
              price: 12,
              category: 'Test',
            },
          };
        }
        return { data: null };
      },
    };
    return api;
  },
};
const compoundMatch = await resolveProductLoaderMatch(fakeSb, {
  code: '8636737332-8636737333',
  displayCode: '8636737332-8636737333',
});
assert.ok(lookupTried.includes('8636737332-8636737333'), 'tries raw compound code first');
assert.ok(lookupTried.includes('8636737332'), 'falls through to first token');
assert.equal(compoundMatch.code, '8636737332');
assert.equal(compoundMatch.websiteRow?.sku, '8636737332');
console.log('✓ Item 2 resolveProductLoaderMatch tries candidate fallbacks');

const noMatchSb = {
  from() {
    const api = {
      select: () => api,
      eq: () => api,
      ilike: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: null }),
    };
    return api;
  },
};
const noCatalogMatch = await resolveProductLoaderMatch(noMatchSb, {
  code: '8610100004&8610100005',
  displayCode: '8610100004&8610100005',
});
assert.equal(noCatalogMatch.title, '', 'no-match lookup leaves title empty');
assert.equal(noCatalogMatch.canPublish, false);
assert.ok(noCatalogMatch.warnings?.includes('not_in_catalog'));
console.log('✓ Archive flow — no-match lookup returns empty title');

assert.doesNotMatch(nutstoreLookupSrc, /title \|\| effectiveCode/, 'lookup never falls back to effectiveCode as title');
assert.match(nutstoreLookupSrc, /rawTitle\.toUpperCase\(\) !== upperEffective/, 'lookup rejects code-as-title from Positill');

const compoundDisplay = catalogueDisplayTitle({
  code: '8610100004',
  displayCode: '8610100004&8610100005&8610100006',
  title: '8610100004',
  sqlRow: { title: '8610100004', code: '8610100004' },
});
assert.equal(compoundDisplay, '', 'catalogueDisplayTitle rejects barcode token as description');
assert.equal(catalogueDescription({
  code: '8610100004',
  sqlRow: { title: '8610100004' },
  websiteRow: { original_description: '8610100004' },
}), '', 'catalogueDescription never returns code/barcode text');
assert.equal(loaderCodeLabel({ displayCode: '8610100004&8610100005', code: '8610100004' }), '8610100004&8610100005', 'loaderCodeLabel prefers full stem');
assert.equal(catalogueDescription({
  code: '8610100004',
  displayCode: '8610100004&8610100005',
  description: '8610100005',
}), '', 'catalogueDescription rejects secondary compound token');
assert.equal(catalogueDisplayTitle({
  code: '8610100004',
  displayCode: '8610100004&8610100005&8610100006',
  title: '',
  sqlRow: { title: '8610100004', code: '8610100004' },
}), '', 'server-side blocks sqlRow barcode title fallback');

const plPublishSrc = readSrc('api/product-loader-publish.js');
assert.match(plPublishSrc, /catalogueDisplayTitle/, 'publish API re-validates title server-side');
assert.doesNotMatch(plPublishSrc, /title \|\| sku/, 'publish API never falls back title to sku');
assert.doesNotMatch(plPublishSrc, /original_description: patch\.original_description \|\| patch\.title/, 'publish create skips title-as-description');

const plDormantSrc = readSrc('api/product-loader-dormant.js');
assert.match(plDormantSrc, /catalogueDisplayTitle/, 'dormant save uses shared title helper');
assert.doesNotMatch(plDormantSrc, /body\.title \|\| sku/, 'dormant save never falls back title to sku');

const plNutstoreSrc = readSrc('src/components/productLoader/ProductLoaderNutstore.jsx');
assert.match(plNutstoreSrc, /catalogueDisplayTitle/, 'nutstore table uses catalogueDisplayTitle');
assert.match(plNutstoreSrc, /LoaderCodeEllipsis value=\{row\.filename\}.*fill/, 'nutstore File column truncates with fill ellipsis');
assert.match(plNutstoreSrc, /pl-table-clip/, 'nutstore table clips overflowing cells');
assert.doesNotMatch(plNutstoreSrc, /maxWidth: 140/, 'nutstore File column no broken inline maxWidth');
const plCss = readSrc('src/index.css');
assert.match(plCss, /pl-table-clip/, 'folder table clip CSS present');
assert.match(plCss, /min-width: 0/, 'table clip uses min-width not max-width zero hack');
assert.doesNotMatch(plCss, /\.pl-table-clip \{ overflow: hidden; max-width: 0/, 'removed broken max-width 0 clip');
assert.match(plCss, /pm-code-ellipsis--fill/, 'table ellipsis fill class present');
assert.match(readSrc('src/pages/AdminPage.jsx'), /type="button".*saveProduct/, 'product editor Save uses type=button');
assert.match(readSrc('src/index.css'), /table-layout: fixed/, 'folder tables use fixed layout for ellipsis');
assert.doesNotMatch(plNutstoreSrc, /item\.title \|\| item\.sqlRow\?\.title \|\| item\.code/, 'nutstore process payload skips code-as-title');

const plApiSrc = readSrc('src/lib/productLoaderApi.js');
assert.match(plApiSrc, /catalogueDisplayTitle/, 'publish API helper uses catalogueDisplayTitle');
assert.doesNotMatch(plApiSrc, /item\.title \|\| item\.sqlRow\?\.title \|\| item\.code/, 'publish API skips code-as-title');
console.log('✓ Product Loader — no barcode in description, code ellipsis');

assert.match(nutstoreProcessSrc, /resolveCatalogTextFields/, 'nutstore archive uses shared no-match text resolver');
assert.match(nutstoreProcessSrc, /if \(!hasMatch\) return \{ title: '', description: '' \}/, 'nutstore skips code fallback when unmatched');

const updateProductRelinkSrc = readSrc('api/update-product.js');
assert.match(updateProductRelinkSrc, /\.from\('archived_products'\)[\s\S]*\.update\(relinkPatch\)/, 'relink writes match fields back to archived row');

const pmEngineArchiveSrc = readSrc('src/components/ProductManagerEngine.jsx');
assert.match(pmEngineArchiveSrc, /productListTitle/, 'archive list avoids sku-as-title fallback');
assert.match(pmEngineArchiveSrc, /pm-code-ellipsis/, 'archive code display uses ellipsis');
assert.match(pmEngineArchiveSrc, /makeLiveItem/, 'single make live opens category picker modal');
assert.doesNotMatch(pmEngineArchiveSrc, /window\.confirm\(`Move "\$\{name\}" to the live website/, 'single make live no longer uses bare confirm');
// Make-live pulls the current taxonomy on open (fresh ids survive renames) and offers deep subcategories
assert.match(pmEngineArchiveSrc, /const makeLive = \(item\) => \{\s*\/\/[\s\S]*?onRefreshTaxonomy\?\.\(\)/, 'make-live refreshes the taxonomy when it opens');
assert.match(pmEngineArchiveSrc, /Child category \{level\}/, 'make-live modal offers dynamic deeper subcategory levels (unlimited depth)');
const adminPageArchiveEditSrc = readSrc('src/pages/AdminPage.jsx');
assert.match(adminPageArchiveEditSrc, /!editingProduct\?\.archivedBy/, 'archive edit modal hides category cascade');
assert.match(adminPageArchiveEditSrc, /!categoryPath\.length && !editingProduct\?\.archivedBy/, 'archive edit save skips category requirement');
console.log('✓ Archive flow — relink, make-live modal, edit modal guards');

const productsSrc = readSrc('src/lib/products.js');
assert.match(productsSrc, /return json;/, 'updateProduct returns API payload including relink');
assert.match(productsSrc, /readApiJson\(res, \{ fallback: 'Update failed' \}\)/, 'updateProduct uses readApiJson (not bare res.json)');
assert.doesNotMatch(productsSrc, /updateProduct[\s\S]*?await res\.json\(\)/, 'updateProduct must not call res.json directly');
const apiErrorSrc = readSrc('src/lib/apiError.js');
assert.match(apiErrorSrc, /JSON\.parse\(text\)/, 'readApiJson parses response text safely');
const bulkEditSrc = readSrc('src/components/BulkProductEditModal.jsx');
assert.match(bulkEditSrc, /relink\?\.matched/, 'bulk edit surfaces Positill relink match toast');
assert.doesNotMatch(bulkEditSrc, /pm-bulk-apply-cat/, 'bulk edit removed apply-category-to-all section');
assert.doesNotMatch(bulkEditSrc, /applyCategoryToAll/, 'bulk edit removed applyCategoryToAll handler');
console.log('✓ Bulk edit modal — apply category to all removed');
const adminPageRelinkSrc = readSrc('src/pages/AdminPage.jsx');
assert.match(adminPageRelinkSrc, /relink\?\.matched/, 'product editor surfaces Positill relink match toast');
console.log('✓ Item 4 client relink toast propagation');


// UI polish — Make live label + move gap validation
const pmEngineSrc = readSrc('src/components/ProductManagerEngine.jsx');
assert.doesNotMatch(pmEngineSrc, /Make live all/, 'Make live all label removed');
assert.match(pmEngineSrc, /Make \{selected\.size\} live/, 'Make live label uses selection count');
assert.doesNotMatch(pmEngineSrc, /: 'Archive all'/, 'Archive all label removed');
assert.match(pmEngineSrc, /`Archive \$\{selected\.size\}`/, 'Archive label uses selection count');

const bulkMoveSrc = readSrc('src/components/BulkMoveModal.jsx');
assert.match(bulkMoveSrc, /hasPathGap/, 'BulkMoveModal enforces contiguous path');
assert.doesNotMatch(bulkMoveSrc, /movePreviewPath\s*=\s*\[[^]*\]\.filter\(Boolean\)/, 'BulkMoveModal no longer silently drops gaps');

const bulkProductsSrc = readSrc('api/bulk-products.js');
assert.match(bulkProductsSrc, /409[^]*Destination category changed/, 'bulk-products returns 409 on stale destination');
console.log('✓ Item 5 UI polish (labels + move gap 409)');

// Perf — heavy section panels are lazy-loaded so the initial AdminPage chunk
// only ships Product Manager. Assert we don't accidentally re-add eager imports.
assert.match(adminPageSrc, /const AnalyticsHub = lazyRetry\(/, 'AnalyticsHub is lazy');
assert.match(adminPageSrc, /const ProductLoaderPanel = lazyRetry\(/, 'ProductLoaderPanel is lazy');
assert.match(adminPageSrc, /const CustomerEmailModal = lazyRetry\(/, 'CustomerEmailModal is lazy');
assert.match(adminPageSrc, /const FulfillmentSettingsModal = lazyRetry\(/, 'FulfillmentSettingsModal is lazy');
assert.doesNotMatch(adminPageSrc, /^import AnalyticsHub /m, 'no eager AnalyticsHub import');
assert.doesNotMatch(adminPageSrc, /^import ProductLoaderPanel /m, 'no eager ProductLoaderPanel import');
// Apollo and the WhatsApp CRM are REMOVED — nothing may quietly reintroduce them.
assert.doesNotMatch(adminPageSrc, /ApolloPanel|WhatsappPanel|CrmContactsModal|OrderWhatsappNotify/, 'Apollo/WhatsApp surfaces stay removed');
assert.match(adminPageSrc, /\{customerEmailOpen && \(/, 'CustomerEmailModal mounts only when open');
assert.match(adminPageSrc, /\{fulfillmentSettingsOpen && \(/, 'FulfillmentSettingsModal mounts only when open');

const sidebarSrc = readSrc('src/components/GroupedSidebar.jsx');
assert.match(sidebarSrc, /CHUNK_PREFETCH/, 'GroupedSidebar warms lazy chunks on hover');
assert.match(sidebarSrc, /newOrdersCount/, 'sidebar shows new order notification badge');
assert.match(sidebarSrc, /Pending trade applications/, 'customer badge tooltip for pending applications');
assert.match(adminPageSrc, /Pre-registration/, 'customer tab renamed to Pre-registration');
assert.match(adminPageSrc, /adm-order-tab--overview/, 'All orders tab uses overview styling');
console.log('✓ Customer/order UX labels + sidebar notification badges');

// Trade application "approved" email — full branded HTML sent on application submit
const tradeEmail = buildTradeApplicationEmail({
  email: 'jane@abc.co.za',
  name: 'Jane Smith',
  businessName: 'ABC Stationers',
});
assert.match(tradeEmail.subject, /approved/i, 'trade application email subject says approved');
assert.match(tradeEmail.html, /^<!DOCTYPE html>/, 'trade application email sends a full standalone HTML document');
assert.match(tradeEmail.html, /APPLICATION<br>\s*<span[^>]*>APPROVED/, 'trade application email keeps the APPROVED header badge');
assert.match(tradeEmail.html, /Dear Jane Smith,/, 'trade application email greets the applicant by name');
assert.doesNotMatch(tradeEmail.html, /\{\{\s*name\s*\}\}/i, 'trade application email resolves the {{name}} tag before sending');
assert.match(tradeEmail.text, /application has been received and your account has been approved/i, 'trade application email has a plain-text fallback');
assert.equal(tradeApplicationGreetingName({ name: 'Jane', email: 'x@y.z' }), 'Jane');
const tradeAppApiSrc = readSrc('api/trade-application-received.js');
assert.match(tradeAppApiSrc, /requireTradeRegisterOrAdmin/, 'trade-application-received uses register secret auth');
assert.match(tradeAppApiSrc, /buildTradeApplicationEmail\b/, 'trade-application-received sends the branded approved email');
assert.match(readSrc('api/register-account.js'), /customer_code:\s*null/, 'register-account never assigns customer_code');
assert.equal(
  spawnSync('node', ['--check', join(REPO_ROOT, 'api/trade-application-received.js')], { encoding: 'utf8' }).status,
  0,
  'trade-application-received.js passes node --check',
);
console.log('✓ Trade application acknowledgment email');

// Customer codes never auto-generated + approval no longer requires a code
const adminCustSrc = readSrc('api/admin-customers.js');
assert.doesNotMatch(adminCustSrc, /A 6-character customer code is required before approval/, 'approval no longer forces a code');
assert.doesNotMatch(approveSrc, /Missing customer code/, 'bulk approve no longer forces a code');
assert.match(readSrc('api/register-account.js'), /customer_code: null/, 'register still never assigns a code');
console.log('✓ Customer codes: manual only, approval not blocked');

// 10000-club welcome/approval email
const welcomeSrc = readSrc('api/_welcome-email.js');
assert.match(welcomeSrc, /export function buildWelcomeEmail/, 'welcome email builder present');
assert.match(welcomeSrc, /export async function sendWelcomeApprovalEmail/, 'welcome email sender present');
assert.match(readSrc('api/register-account.js'), /sendWelcomeApprovalEmail/, 'auto-approval sends the welcome email');
assert.match(adminCustSrc, /sendWelcomeApprovalEmail/, 'admin approve sends the welcome email');
console.log('✓ Welcome / approval email on approval');

// Manual add-customer with section selection
assert.match(adminCustSrc, /req\.method === 'POST'/, 'admin-customers accepts manual add (POST)');
assert.match(adminCustSrc, /section === 'pre-registration'/, 'add-customer supports pre-registration');
assert.match(adminCustSrc, /section === 'approved'/, 'add-customer supports approved');
assert.match(readSrc('src/lib/customers.js'), /export async function addCustomerManually/, 'client add-customer present');
assert.match(readSrc('src/components/AddCustomerModal.jsx'), /export default function AddCustomerModal/, 'AddCustomerModal component present');

// Per-customer last-email status
assert.match(readSrc('api/_customer-email-status.js'), /export async function markCustomerEmailed/, 'last-email marker present');
assert.match(readSrc('api/_send-email-broadcast.js'), /markCustomersEmailed/, 'broadcast stamps last-email');
assert.match(readSrc('src/pages/AdminPage.jsx'), /function LastEmailBadge/, 'last-email badge rendered');
// Send to specific people (explicit email list) — for testing + a handful of customers
assert.match(readSrc('api/_send-email-broadcast.js'), /'selected'/, 'broadcast audience allows a selected email list');
assert.match(readSrc('api/_send-email-broadcast.js'), /fetchRecipientsByEmail/, 'broadcast can resolve an explicit recipient list');
assert.match(readSrc('api/_brevo-email.js'), /export async function fetchRecipientsByEmail/, 'recipient-by-email resolver present (personalizes known customers)');
assert.match(readSrc('api/customer-email-broadcast.js'), /const isSelected =/, 'send endpoint handles the specific-people path');
assert.match(readSrc('src/components/CustomerEmailModal.jsx'), /Specific people \(enter emails\)/, 'email modal offers a specific-people audience');
assert.match(readSrc('src/components/CustomerEmailModal.jsx'), /export function parseEmailList/, 'email modal parses a typed/pasted email list');
{
  const { parseEmailList } = await import('../src/components/CustomerEmailModal.jsx').catch(() => ({}));
  if (parseEmailList) {
    assert.deepEqual(parseEmailList('a@b.co, a@b.co\nbad  c@d.co'), ['a@b.co', 'c@d.co'], 'parseEmailList dedupes + drops invalid');
  }
}
assert.ok(readSrc('migrations/042_customer_last_email.sql').includes('last_email_type'), 'migration 042 adds last-email columns');

// Per-template test send + Brevo webhook robustness
assert.match(readSrc('api/email-test-send.js'), /template === 'welcome'/, 'test-send handles welcome template');
assert.match(readSrc('api/email-test-send.js'), /template === 'order_confirmation'/, 'test-send handles order confirmation');
assert.match(readSrc('src/components/EmailTemplateTests.jsx'), /sendEmailTemplateTest/, 'template test UI present');
const webhookSrc2 = readSrc('api/brevo-email-webhook.js');
assert.match(webhookSrc2, /x-webhook-secret/, 'webhook accepts the secret via header');
// Was: asserted the webhook accepted events unauthenticated with a warning.
// a0278f7 deliberately made it fail closed, so that assertion has been failing
// since 2026-07-18 and was pinning the insecure behaviour.
assert.match(webhookSrc2, /Webhook authentication is not configured/, 'webhook fails closed when no secret is set');
assert.match(webhookSrc2, /Bearer\\s\+/, 'webhook strips the Bearer prefix before comparing');
console.log('✓ Add-customer, last-email status, per-template test send, webhook robustness');

// Simplified email merge fields — one reliable "name", no blank-prone codes
const mergeSrc = readSrc('src/lib/emailMergeTags.js');
assert.doesNotMatch(mergeSrc, /key: 'first_name'/, 'first_name merge chip removed (one name)');
assert.doesNotMatch(mergeSrc, /key: 'customer_code'/, 'customer_code merge chip removed (usually blank)');
assert.match(mergeSrc, /key: 'name'/, 'single name merge field kept');
assert.match(readSrc('src/components/CustomerEmailModal.jsx'), /Add HTML \/ banner/, 'HTML block collapsed behind a toggle');
console.log('✓ Simplified email compose (one name, HTML optional)');

// Bundle-perf follow-ups
const orderDocsSrc = readSrc('src/lib/orderDocuments.js');
assert.doesNotMatch(orderDocsSrc, /^import \{ jsPDF \} from 'jspdf'/m, 'jspdf no longer statically imported');
assert.match(orderDocsSrc, /loadJsPDF/, 'orderDocuments uses lazy jspdf loader');

// Order confirmation PDF — packing-slip layout with the Proto Trading Online banner
assert.match(orderDocsSrc, /doc\.text\('ONLINE'/, 'order confirmation banner says PROTO TRADING ONLINE');
assert.match(orderDocsSrc, /SHIPPING METHOD/, 'order confirmation shows the shipping-method banner');
assert.match(orderDocsSrc, /doc\.text\('BARCODE'/, 'order confirmation table has a Barcode column');
assert.match(orderDocsSrc, /doc\.text\('AVAIL'/, 'order confirmation table has an Avail column');
assert.match(orderDocsSrc, /drawAddressBlock\('Invoice To'/, 'order confirmation renders the Invoice To block');
assert.match(orderDocsSrc, /drawAddressBlock\('Delivery Address'/, 'order confirmation renders the Delivery Address block');
{
  const { pdfShippingMethod, invoiceToLines, deliveryAddressLines } = await import('../lib/order-format.mjs');
  assert.equal(pdfShippingMethod({ delivery_method: 'proto-deliver' }), 'Proto to Quote Delivery', 'proto delivery → Proto to Quote Delivery');
  assert.equal(pdfShippingMethod({ delivery_method: 'pickup' }), 'In store pick up', 'pickup → In store pick up');
  assert.equal(pdfShippingMethod({}), 'Proto to Quote Delivery', 'empty delivery defaults to Proto to Quote Delivery');
  const inv = invoiceToLines({ customers: { contact_name: 'Jane', business_name: 'ABC', phone: '021', email: 'a@b.co', city: 'CT', country: 'ZA' } });
  assert.ok(inv.some((l) => l.startsWith('Phone:')) && inv.some((l) => l.startsWith('Email:')), 'invoice block carries phone + email');
  assert.ok(deliveryAddressLines({ customers: {} }).length > 0, 'delivery block always has a fallback line');
}

// Apollo is removed entirely — no component may statically import jspdf.


const lazyJsPdfSrc = readSrc('src/lib/lazyJspdf.js');
assert.match(lazyJsPdfSrc, /_jspdfPromise/, 'lazyJspdf caches the dynamic import');

const useCatalogSrc = readSrc('src/hooks/useCatalog.js');
assert.match(useCatalogSrc, /Promise\.all\(Array\.from\(\{ length: Math\.min\(CONCURRENCY/, 'fetchAllCatalogRows fans out in parallel');

const taxonomySrc = readSrc('api/taxonomy.js');
assert.match(taxonomySrc, /Cache-Control', 's-maxage=\d+, stale-while-revalidate=\d+/, 'taxonomy counts endpoint has SWR cache');

console.log('✓ Bundle + perf follow-ups (jspdf lazy, catalog parallel, counts SWR)');

// Section split — Banner + Specials extracted to their own lazy panels
assert.match(adminPageSrc, /const BannerPanel = lazyRetry\(/, 'BannerPanel is lazy');
assert.match(adminPageSrc, /const SpecialsPanel = lazyRetry\(/, 'SpecialsPanel is lazy');
assert.doesNotMatch(adminPageSrc, /^import BannerPanel /m, 'BannerPanel not eagerly imported');
assert.doesNotMatch(adminPageSrc, /^import SpecialsPanel /m, 'SpecialsPanel not eagerly imported');
assert.doesNotMatch(adminPageSrc, /const loadBannerEditor = async/, 'loadBannerEditor moved into BannerPanel');
assert.doesNotMatch(adminPageSrc, /const loadPopupEditor = async/, 'loadPopupEditor moved into SpecialsPanel');
assert.doesNotMatch(adminPageSrc, /const loadCheckoutPromoEditor = async/, 'loadCheckoutPromoEditor moved into SpecialsPanel');
assert.doesNotMatch(adminPageSrc, /const savePopupEditor = async/, 'savePopupEditor moved into SpecialsPanel');
assert.doesNotMatch(adminPageSrc, /const handleBannerImage = async/, 'handleBannerImage moved into BannerPanel');

const bannerPanel = readSrc('src/components/BannerPanel.jsx');
assert.match(bannerPanel, /export default function BannerPanel/, 'BannerPanel exports a default component');

const specialsPanel = readSrc('src/components/SpecialsPanel.jsx');
assert.match(specialsPanel, /export default function SpecialsPanel/, 'SpecialsPanel exports a default component');
assert.match(specialsPanel, /onSpecialsChange/, 'SpecialsPanel accepts an onSpecialsChange prop for parent star-toggle');

assert.match(sidebarSrc, /'site-content': \(\) => import\('\.\/FeaturedPanel'\)/, 'sidebar prefetches the merged Site Content section on hover');
console.log('✓ AdminPage split — BannerPanel + SpecialsPanel extracted, lazy, merged into Site Content');

// Featured products tab
const featuredApiSrc = readSrc('api/featured-products.js');
assert.match(featuredApiSrc, /featured-products\.json/, 'featured API persists to featured-products.json');
assert.match(featuredApiSrc, /MAX_ITEMS = 100/, 'featured API hard cap is 100');

const featuredLibSrc = readSrc('src/lib/featuredProducts.js');
assert.match(featuredLibSrc, /FEATURED_SOFT_CAP = 60/, 'featured soft cap is 60');
assert.match(featuredLibSrc, /FEATURED_HARD_CAP = 100/, 'featured hard cap is 100');

const featuredPanelSrc = readSrc('src/components/FeaturedPanel.jsx');
assert.match(featuredPanelSrc, /export default function FeaturedPanel/, 'FeaturedPanel default export');
assert.match(featuredPanelSrc, /SectionErrorBoundary name="featured"/, 'FeaturedPanel wrapped in SectionErrorBoundary');
assert.doesNotMatch(featuredPanelSrc, /window\.__featured/, 'FeaturedPanel drag avoids window globals');

assert.match(sidebarSrc, /id: 'site-content'/, 'sidebar has the merged Site Content nav item');
assert.match(sidebarSrc, /'site-content': \(\) => import\('\.\/FeaturedPanel'\)/, 'sidebar prefetches FeaturedPanel on hover');
assert.match(adminPageSrc, /const FeaturedPanel = lazyRetry\(/, 'FeaturedPanel is lazy in AdminPage');
assert.match(adminPageSrc, /activeSection === 'site-content'/, 'AdminPage renders Featured under Site Content section');
console.log('✓ Featured products tab (API, panel, sidebar, lazy load)');

// PricingPanel extraction
assert.match(adminPageSrc, /const PricingPanel = lazyRetry\(/, 'PricingPanel is lazy');
assert.doesNotMatch(adminPageSrc, /const applyPricing = async/, 'applyPricing moved into PricingPanel');
assert.doesNotMatch(adminPageSrc, /const toggleSelectAllPricing = /, 'toggleSelectAllPricing moved into PricingPanel');
assert.doesNotMatch(adminPageSrc, /const loadCategoryWorkingSet = async/, 'loadCategoryWorkingSet dispatcher removed');
assert.doesNotMatch(adminPageSrc, /const \[pricingCategory,/, 'pricing state moved out of AdminPage');
assert.doesNotMatch(adminPageSrc, /const \[priceDelta,/, 'priceDelta state moved out of AdminPage');

const pricingPanel = readSrc('src/components/PricingPanel.jsx');
assert.match(pricingPanel, /export default function PricingPanel/, 'PricingPanel default export');
assert.match(pricingPanel, /fetchReorderProducts\(\{ mainCategory: categoryId \}\)/, 'PricingPanel fetches category rows');

assert.match(sidebarSrc, /pricing: \(\) => import\('\.\/PricingPanel'\)/, 'sidebar prefetches PricingPanel on hover');
console.log('✓ PricingPanel extracted, lazy, prefetched');

// ReorderPanel + TaxonomyModals extraction
assert.match(adminPageSrc, /const ReorderPanel = lazyRetry\(/, 'ReorderPanel is lazy');
assert.doesNotMatch(adminPageSrc, /const \[reorderCategoryPath,/, 'reorder state moved out of AdminPage');
assert.doesNotMatch(adminPageSrc, /const \[moveModalOpen,/, 'reorder move modal state moved out of AdminPage');
assert.doesNotMatch(adminPageSrc, /import ReorderGrid from/, 'ReorderGrid only imported by ReorderPanel');
assert.match(adminPageSrc, /<TaxonomyModals/, 'TaxonomyModals used once at page level');
assert.doesNotMatch(adminPageSrc, /Rename \{editTaxonomyModal\.type/, 'inline taxonomy rename modal removed');

const reorderPanel = readSrc('src/components/ReorderPanel.jsx');
assert.match(reorderPanel, /adm-reorder-toolbar/, 'ReorderPanel owns reorder toolbar');
assert.match(reorderPanel, /forwardRef\(function ReorderPanel/, 'ReorderPanel uses forwardRef for imperative refresh');

const taxonomyModals = readSrc('src/components/TaxonomyModals.jsx');
assert.match(taxonomyModals, /export default function TaxonomyModals/, 'TaxonomyModals default export');

assert.match(sidebarSrc, /reorder: \(\) => import\('\.\/ReorderPanel'\)/, 'sidebar prefetches ReorderPanel on hover');
console.log('✓ ReorderPanel + TaxonomyModals extracted');

// Live product visibility — Product Manager default matches Reorder Grid + dashboard count
assert.match(catalogSrc, /onlyInStock/, 'catalog API supports onlyInStock query param');
assert.match(catalogSrc, /useFullScan = onlyInStock/, 'onlyInStock uses fetch-all-enrich-filter path');
assert.match(catalogSrc, /if \(onlyInStock\) \{\s*\n\s*rows = rows\.filter\(isPublishableOnWebsite\)/, 'stock filter only when onlyInStock=true');
assert.match(
  catalogSrc,
  /result = await queryLivePaginated[\s\S]*?const rows = await enrichRowsWithProductStock\(sb, result\.rows\);\n        result = \{ \.\.\.result, rows \};/,
  'default paginated live path enriches without stock filter',
);
assert.match(pmEngineSrc, /NeedsSohPriceBadge/, 'Needs SOH/price badge for unlinked zero-stock live rows');
assert.match(pmEngineSrc, /OutOfStockLinkedBadge/, 'Out of stock badge for ERP-linked zero-stock rows');
assert.match(pmEngineSrc, /soh !== 0 \|\| item\.stockLinked !== true/, 'OOS badge when zero SOH and stockLinked true');
assert.match(pmEngineSrc, /'In stock only'/, 'Product Manager only-in-stock filter option');
assert.match(readSrc('src/lib/products.js'), /onlyInStock=false/, 'fetchReorderProducts documents catalog parity');
assert.match(readSrc('api/_catalog-adapt.js'), /stockLinked/, 'catalog rows expose stockLinked for badge');
console.log('✓ Live product visibility policy (PM default = Reorder Grid)');

const boundaryCount = (adminPageSrc.match(/<SectionErrorBoundary/g) || []).length;
// 11 sections since Apollo and the WhatsApp CRM were removed.
assert.ok(boundaryCount >= 11, `AdminPage should wrap all sections in SectionErrorBoundary (found ${boundaryCount})`);
console.log('✓ AdminPage section error boundaries');

const lazyRetrySrc = readSrc('src/lib/lazyRetry.js');
assert.match(lazyRetrySrc, /isChunkLoadError/, 'chunk load error detector present');
assert.match(lazyRetrySrc, /vite:preloadError/, 'vite preload error handler installed');
assert.match(readSrc('vite.config.js'), /manualChunks/, 'vite manualChunks splits vendor deps');
assert.match(adminPageSrc, /lazyRetry/, 'AdminPage uses lazyRetry for section panels');
console.log('✓ Lazy chunk load recovery (lazyRetry + vite manualChunks)');

// Bulk image replace tab
assert.match(readSrc('src/lib/bulkImageReplace.js'), /BULK_IMAGE_REPLACE_MAX = 500/, 'bulk image replace cap is 500');
const birSlot1 = parseIntakeFilename('BASHEWS.jpg');
assert.equal(birSlot1.sourceSku, 'BASHEWS');
assert.equal(birSlot1.imageNumber, 1);
const birSlot2 = parseIntakeFilename('BASHEWS.2.jpg');
assert.equal(birSlot2.imageNumber, 2);
assert.equal(birSlot2.sourceSku, 'BASHEWS');
assert.match(readSrc('api/bulk-image-replace.js'), /BULK_IMAGE_REPLACE_MAX/, 'bulk image replace API enforces cap');
assert.match(readSrc('src/components/BulkImageReplacePanel.jsx'), /export default function BulkImageReplacePanel/, 'BulkImageReplacePanel export');
// Image replace matches a labelled file by the product's SKU OR its barcode/code
// (so an image named with the code still replaces after the code diverges from SKU).
const birLibSrc = readSrc('src/lib/bulkImageReplace.js');
assert.match(birLibSrc, /barcode: row\.barcode \|\| row\.code/, 'selection carries the product barcode/code');
assert.match(birLibSrc, /skuByIdentifier/, 'preflight maps SKU + barcode to the owning product SKU');
assert.match(readSrc('api/bulk-image-replace.js'), /fileSku === rowBarcode/, 'server accepts a filename that matches the row barcode');
assert.match(readSrc('api/bulk-image-replace.js'), /select\('sku, archived_by, barcode'\)/, 'archived lookup fetches the barcode for matching');
// Replaced image URL is cache-busted so the new picture actually shows (not the cached old one)
assert.match(readSrc('api/bulk-image-replace.js'), /const bustedUrl = `\$\{publicUrl\}\?v=\$\{Date\.now\(\)\}`/, 'replaced image URL carries a version param to bust the cache');
assert.match(readSrc('api/bulk-image-replace.js'), /\[col\]: bustedUrl/, 'the cache-busted URL is what gets stored');
// Results step previews the new image so it can be confirmed before another run
assert.match(readSrc('src/components/BulkImageReplacePanel.jsx'), /src=\{r\.url\}/, 'results show a preview of the replaced image');
assert.match(sidebarSrc, /id: 'image-replace'/, 'sidebar has Image Replace nav');
assert.match(adminPageSrc, /BulkImageReplacePanel/, 'AdminPage lazy-loads BulkImageReplacePanel');
assert.doesNotMatch(readSrc('src/components/ProductLoaderPanel.jsx'), /image-replace/, 'Image Replace removed from Product Loader');
console.log('✓ Bulk image replace tab (wizard, API, 500 cap)');

// Taxonomy integrity (A1–A5) — count parity, tolerant matching, delete
// clearing, persisted Mottaro paths, post-move refresh.

// Shared label matcher
assert.equal(normalizeLabel('  Fasteners  '), 'fasteners');
assert.equal(normalizeLabel('School  &   Office'), 'school & office');
assert.ok(matchesTaxonomyLabel(' Fasteners ', 'fasteners'), 'matcher tolerates padding + case');
assert.ok(!matchesTaxonomyLabel('Fasteners', ''), 'empty tree label never matches');
assert.ok(rowMatchesLabelScope(
  { category: ' arts and crafts', subcategory_one: 'Art Supplies ' },
  { category: 'Arts and Crafts', subcategory_one: 'Art Supplies' },
), 'scope match tolerates whitespace drift');
assert.equal(escapeIlikePattern('50%_a\\b'), '50\\%\\_a\\\\b', 'ilike pattern escaping');
console.log('✓ A3 shared taxonomy label matcher');

// Rename + delete server paths use the tolerant matcher, not raw .eq only
const taxonomyApiSrc = readSrc('api/taxonomy.js');
assert.match(taxonomyApiSrc, /renameNodeLabelInProducts/, 'rename uses shared tolerant rename helper');
assert.match(taxonomyApiSrc, /orphansRemaining/, 'rename returns orphansRemaining verification');
assert.match(taxonomyApiSrc, /archiveProductsForDeletedNode/, 'deleteNode archives products under the node');
assert.match(taxonomyApiSrc, /productsArchived/, 'deleteNode reports productsArchived');
assert.doesNotMatch(taxonomyApiSrc, /action === 'deleteSubcategory'/, 'dead deleteSubcategory action removed');
const taxonomyUtilsSrc2 = readSrc('api/_taxonomy-utils.js');
assert.match(taxonomyUtilsSrc2, /fetchRowsMatchingNodeScope/, 'scope fetch helper present');
assert.match(taxonomyUtilsSrc2, /rowMatchesLabelScope/, 'scope fetch verifies with shared matcher');
console.log('✓ A2/A3 rename + delete use tolerant matching');

// buildClearLabelsPatch depth behaviour
// category / subcategory_one are NOT NULL in website_stock — cleared to ''
// (the uncategorised representation), deeper nullable columns to null.
assert.deepEqual(buildClearLabelsPatch({ depth: 0 }), {
  category: '',
  subcategory_one: '',
  subcategory_two: null,
  subcategory_three: null,
  subcategory_four: null,
  subcategory_extra: null,
}, 'main-category delete clears category + all sub columns (shallow duplicate included)');
assert.deepEqual(buildClearLabelsPatch({ depth: 1 }), {
  subcategory_one: '',
  subcategory_two: null,
  subcategory_three: null,
  subcategory_four: null,
  subcategory_extra: null,
}, 'depth-1 delete clears subcategory_one to empty string (NOT NULL column)');
assert.deepEqual(buildClearLabelsPatch({ depth: 2 }), {
  subcategory_two: null,
  subcategory_three: null,
  subcategory_four: null,
  subcategory_extra: null,
}, 'depth-2 delete clears column 2 and deeper only');
console.log('✓ A2 buildClearLabelsPatch depth-aware clearing');

// Unlimited category depth (subcategory_extra overflow beyond subcategory_four)
{
  const c6 = { id: 'c6', label: 'C6', children: [] };
  const c5 = { id: 'c5', label: 'C5', children: [c6] };
  const c4 = { id: 'c4', label: 'C4', children: [c5] };
  const c3 = { id: 'c3', label: 'C3', children: [c4] };
  const c2 = { id: 'c2', label: 'C2', children: [c3] };
  const c1 = { id: 'c1', label: 'C1', children: [c2] };
  const main = { id: 'main', label: 'Main', children: [c1] };
  const deepTree = [main];

  const deepLabels = ['Main', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
  const deepDbFields = labelsToDbFields(deepLabels);
  assert.equal(deepDbFields.subcategory_extra, JSON.stringify(['C5', 'C6']), 'labelsToDbFields stores depth beyond 4 as subcategory_extra');

  const deepRow = {
    category: deepDbFields.category,
    subcategory_one: deepDbFields.subcategory_one,
    subcategory_two: deepDbFields.subcategory_two,
    subcategory_three: deepDbFields.subcategory_three,
    subcategory_four: deepDbFields.subcategory_four,
    subcategory_extra: deepDbFields.subcategory_extra,
  };
  const deepResolved = resolveCategoryIds(deepRow, deepTree);
  assert.deepEqual(deepResolved.categoryPath, ['main', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], 'resolveCategoryIds round-trips depth-6 paths through subcategory_extra');

  function findDeepCtx(tree, id, parent = null, depth = 0, ancestors = []) {
    for (const node of tree) {
      if (node.id === id) return { node, parent, depth, ancestors: [...ancestors] };
      if (node.children?.length) {
        const hit = findDeepCtx(node.children, id, node, depth + 1, [...ancestors, node]);
        if (hit) return hit;
      }
    }
    return null;
  }
  const ctxC6 = findDeepCtx(deepTree, 'c6');
  assert.equal(nodeScopeColumn(ctxC6), 'subcategory_extra', 'depth-6 node scope column is subcategory_extra');
  const clearC6 = buildClearLabelsPatch(ctxC6);
  assert.equal(clearC6.subcategory_extra, JSON.stringify(['C5']), 'deleting a depth-6 node preserves its depth-5 ancestor in subcategory_extra');
  assert.ok(rowMatchesLabelScope(deepRow, buildNodeProductFilter(ctxC6).filters), 'buildNodeProductFilter matches the row it was derived from');
  assert.ok(
    rowMatchesLabelScope({ ...deepRow, subcategory_extra: JSON.stringify(['C5', 'C6', 'C7']) }, buildNodeProductFilter(ctxC6).filters),
    'a depth-7 descendant still matches its depth-6 ancestor scope',
  );

  // depth <= 4 behaviour must stay byte-identical to before subcategory_extra existed
  const ctxC4 = findDeepCtx(deepTree, 'c4');
  assert.ok(!('subcategory_extra' in buildNodeProductFilter(ctxC4).filters), 'depth<=4 node filters never reference subcategory_extra');
  assert.equal(nodeScopeColumn(ctxC4), 'subcategory_four', 'depth-4 node scope column unchanged');
}
console.log('✓ Unlimited category depth via subcategory_extra overflow');

// Product Manager deep-browse (api/catalog.js) must resolve depth>4 exactly.
{
  const c6 = { id: 'c6', label: 'C6', children: [] };
  const c5 = { id: 'c5', label: 'C5', children: [c6] };
  const c4 = { id: 'c4', label: 'C4', children: [c5] };
  const c3 = { id: 'c3', label: 'C3', children: [c4] };
  const c2 = { id: 'c2', label: 'C2', children: [c3] };
  const c1 = { id: 'c1', label: 'C1', children: [c2] };
  const deepTree = [{ id: 'main', label: 'Main', children: [c1] }];
  const deepPath = ['main', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];

  // A depth-6 browse path must be routed through the full-scan JS refine
  // (SQL .eq() can't match subcategory_extra exactly).
  assert.ok(categoryPathExceedsFixedColumns(deepPath), 'depth-6 path flagged as beyond fixed columns');
  assert.ok(!categoryPathExceedsFixedColumns(['main', 'c1', 'c2', 'c3', 'c4']), 'depth-4 path stays on the fast SQL path');

  // resolveCategoryFilters emits the fixed columns + a coarse ilike on the
  // deepest extra label; the SQL narrow must never key an undefined column.
  const filters = resolveCategoryFilters(deepTree, deepPath);
  assert.equal(filters.subcategory_four, 'C4', 'fixed columns still resolved for deep path');
  assert.equal(filters.subcategoryExtraDeepest, 'C6', 'deepest extra label exposed for coarse SQL narrow');
  assert.ok(!('undefined' in filters), 'deep path never writes filters[undefined]');
  // Prove the ilike clause is applied (fake query recorder).
  const applied = [];
  const fakeQ = {
    eq(col, val) { applied.push(['eq', col, val]); return this; },
    or(expr) { applied.push(['or', expr]); return this; },
    ilike(col, pat) { applied.push(['ilike', col, pat]); return this; },
  };
  applyCategoryFiltersToQuery(fakeQ, filters);
  assert.ok(applied.some(([op, col]) => op === 'ilike' && col === 'subcategory_extra'), 'deep path adds an ilike narrow on subcategory_extra');

  // filterByCategoryPath (the exact JS refine) keeps a matching row and drops a
  // sibling that only shares the fixed-column prefix.
  const deepFields = labelsToDbFields(['Main', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  const matchRow = { sku: 'A', ...deepFields };
  const siblingRow = { sku: 'B', ...labelsToDbFields(['Main', 'C1', 'C2', 'C3', 'C4', 'C5', 'OTHER']) };
  const shallowRow = { sku: 'C', ...labelsToDbFields(['Main', 'C1', 'C2', 'C3', 'C4']) };
  const kept = filterByCategoryPath([matchRow, siblingRow, shallowRow], deepPath, deepTree).map((r) => r.sku);
  assert.deepEqual(kept, ['A'], 'deep JS refine keeps only the exact-path row, drops sibling + shallow ancestor');

  // adaptCatalogRow surfaces the full-depth subcategoryLabels for the UI.
  const adapted = adaptCatalogRow(matchRow, deepTree);
  assert.deepEqual(adapted.subcategoryLabels, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], 'adaptCatalogRow includes subcategory_extra labels');
  assert.deepEqual(adapted.categoryPath, deepPath, 'adaptCatalogRow builds the full-depth categoryPath');
}
console.log('✓ Product Manager deep-browse (catalog) resolves depth>4 exactly');

// parseExtraLabels tolerates junk without throwing.
assert.deepEqual(parseExtraLabels(null), []);
assert.deepEqual(parseExtraLabels('not json'), []);
assert.deepEqual(parseExtraLabels('["X","Y"]'), ['X', 'Y']);
console.log('✓ parseExtraLabels is null/garbage tolerant');

// Product lists default to most-recently-edited first (updated_at desc) so an
// edited / archived / restored product surfaces at the top. api/catalog.js maps
// sort='updated' → updated_at desc, and the archive RPCs stamp updated_at.
{
  const useCatalogSrc = readSrc('src/hooks/useCatalog.js');
  assert.match(useCatalogSrc, /sort = 'updated'/, 'buildCatalogParams defaults to updated (recently-edited first)');
  assert.match(useCatalogSrc, /params\.sort \|\| 'updated'/, 'fetchCatalog falls back to updated, not title');
  const catalogApiSrc = readSrc('api/catalog.js');
  assert.match(catalogApiSrc, /sort === 'updated'[\s\S]*?updated_at[\s\S]*?ascending: false/, "catalog maps 'updated' → updated_at desc");
  const sidebarSrc = readSrc('src/components/GroupedSidebar.jsx');
  assert.match(sidebarSrc, /sort: 'updated'/, 'sidebar prefetch matches the updated-first default so it primes the same cache entry');
}
console.log('✓ Catalog lists default to recently-edited-first');

// Make-live: an explicit publish must survive the auto-OOS visibility rule, and
// the category picker must allocate the FULL subcategory depth (subcategory_extra).
{
  const ensureSrc = readSrc('api/_ensure-product.js');
  assert.match(ensureSrc, /keepLiveWhenOos = true/, 'restoreArchivedToLive defaults keepLiveWhenOos true');
  // keep-live flag is set BEFORE the visibility sync RPC so the publish sticks.
  const keepIdx = ensureSrc.indexOf('keep_live_when_oos: true');
  const syncIdx = ensureSrc.indexOf("rpc('sync_website_from_products')");
  assert.ok(keepIdx > 0 && syncIdx > keepIdx, 'keep_live_when_oos is stamped before sync_website_from_products re-archives OOS rows');

  const pmSrc = readSrc('src/components/ProductManagerEngine.jsx');
  assert.doesNotMatch(pmSrc, /makeLiveCategory\.childOneId|childFourId/, 'make-live picker no longer uses fixed child slots');
  assert.match(pmSrc, /makeLiveCategory\.childIds/, 'make-live picker uses the dynamic childIds array');
  assert.match(pmSrc, /\[makeLiveCategory\.categoryId, \.\.\.\(makeLiveCategory\.childIds \|\| \[\]\)\]/, 'confirmMakeLive builds the full-depth path from childIds');
}
console.log('✓ Make-live keeps products visible + allocates full subcategory depth');

// "To order": admin can flag a product orderable at zero stock (button + filter),
// written via a real stock-actions handler and surfaced on adapted rows.
{
  const stockActionsSrc = readSrc('api/stock-actions.js');
  assert.match(stockActionsSrc, /action === 'setToOrder'/, 'stock-actions has a setToOrder handler');
  assert.match(stockActionsSrc, /to_order: true, keep_live_when_oos: true/, 'setToOrder marks to_order AND keeps it live-when-oos so it stays visible + orderable');
  // The New Arrivals toggle POSTs action:'setNewArrival' — the handler must
  // exist or the button errors with "Unknown action: setNewArrival".
  assert.match(stockActionsSrc, /action === 'setNewArrival'/, 'stock-actions has a setNewArrival handler');
  assert.match(stockActionsSrc, /is_new_arrival: !!isNewArrival/, 'setNewArrival writes the is_new_arrival column');
  assert.match(stockActionsSrc, /'is_new_arrival', 'to_order'/, 'live list selects to_order');
  const prodSrc = readSrc('src/lib/products.js');
  assert.match(prodSrc, /export async function setToOrder/, 'products lib exposes setToOrder');
  assert.match(prodSrc, /toOrder: !!row\.to_order/, 'adapt surfaces toOrder');
  const catSrc = readSrc('api/catalog.js');
  assert.match(catSrc, /toOrderOnly/, 'catalog supports the to-order-only filter');
  assert.match(catSrc, /q\.eq\('to_order', true\)/, 'to-order filter narrows on the column');
  const adaptSrc = readSrc('api/_catalog-adapt.js');
  assert.match(adaptSrc, /toOrder: !!row\.to_order/, 'catalog-adapt exposes toOrder on admin rows');
  assert.match(adaptSrc, /isNew: !!row\.is_new_arrival/, 'catalog-adapt exposes isNew on admin rows');
  const pmSrc2 = readSrc('src/components/ProductManagerEngine.jsx');
  assert.match(pmSrc2, /setToOrder\.mutate/, 'PM has a To order toggle button');
  assert.match(pmSrc2, /To order only/, 'PM has a To order filter chip');
  // Sparkles toggle now flags Specials (column stays is_new_arrival); rows badge
  // "Special" + "To order".
  assert.match(pmSrc2, />To order</, 'desktop row renders a To order badge');
  assert.match(pmSrc2, />Special</, 'desktop row renders a Special badge (repurposed sparkles)');
  // Search input is isolated so keystrokes don't re-render the product list.
  assert.match(pmSrc2, /const PmSearchField = memo\(/, 'search input isolated into a memoized field');
  assert.doesNotMatch(pmSrc2, /value=\{searchInput\}/, 'parent no longer binds the raw search value');
}

// "Stock available" is a boolean quick toggle. It stores a tiny private marker
// so the existing GRV trigger clears it on the next positive ERP stock move.
{
  const mutationSrc = readSrc('src/hooks/useCatalogMutations.js');
  const pmSrc = readSrc('src/components/ProductManagerEngine.jsx');
  assert.match(mutationSrc, /incomingStatus: stockAvailable \? 'landed_awaiting_grv' : 'none'/, 'toggle writes the arrived state');
  assert.match(mutationSrc, /incomingQty: stockAvailable \? 0\.001 : 0/, 'toggle uses the GRV-clear marker quantity');
  assert.match(pmSrc, /const stockAvailable = !item\.stockAvailable/, 'PM exposes Stock available as an on\/off toggle');
  assert.doesNotMatch(pmSrc, /window\.prompt|How many units/, 'Stock available never prompts for a quantity');
}
console.log('✓ To-order admin toggle/filter + isolated search input');

// Pick up in store delivery method flows through the shared formatter.
assert.match(readSrc('lib/order-format.mjs'), /pick.?up|collect|in.?store/i, 'order-format recognises the pickup delivery method');
console.log('✓ Pick up in store delivery method');

// A1 — count/content parity
assert.match(taxonomyUtilsSrc2, /onlyInStock && !isPublishableOnWebsite/, 'counts stock gate only when onlyInStock');
assert.match(taxonomyApiSrc, /onlyInStock/, 'taxonomy counts endpoint accepts onlyInStock');
const taxonomyAdminSrc2 = readSrc('src/lib/taxonomyAdmin.js');
assert.match(taxonomyAdminSrc2, /onlyInStock=1/, 'fetchCategoryProductCounts passes onlyInStock query param');
const pmEngineSrc2 = readSrc('src/components/ProductManagerEngine.jsx');
assert.match(pmEngineSrc2, /fetchCategoryProductCounts\(\{ onlyInStock: true \}\)/, 'PM reloads stock-filtered counts when toggle on');
assert.match(pmEngineSrc2, /productCounts=\{effectiveCategoryCounts\}/, 'category badges use toggle-aware counts');
console.log('✓ A1 count badges match list contents in both stock modes');

// A4 — persisted Mottaro path
const mottaroTree = injectMotarroIntoTree([
  {
    id: 'arts-and-crafts',
    label: 'Arts and Crafts',
    children: [
      { id: 'art-supplies', label: 'Art Supplies', children: [{ id: 'brushes', label: 'Brushes', children: [] }] },
      { id: 'crafts', label: 'Crafts', children: [] },
    ],
  },
  { id: 'stationery', label: 'Stationery', children: [] },
]);
assert.deepEqual(
  deriveMotarroPathFromLabels(['Arts and Crafts', 'Art Supplies', 'Brushes'], mottaroTree),
  ['mottaro', 'mottaro-art-supplies', 'mottaro-brushes'],
  'derivation from labels resolves branch',
);
assert.deepEqual(
  inferMotarroPathFromRow({ title: 'MOTTARO brush', category: null, mottaro_path: '["mottaro","mottaro-crafts"]' }, mottaroTree),
  ['mottaro', 'mottaro-crafts'],
  'stored mottaro_path wins when labels are gone',
);
assert.deepEqual(
  inferMotarroPathFromRow({ title: 'MOTTARO thing', category: '', mottaro_path: '["bogus"]' }, mottaroTree),
  ['mottaro', 'mottaro-other', 'mottaro-other-general'],
  'invalid stored path falls back to Other›General',
);
assert.equal(motarroPathSnapshot(['mottaro']), null, 'bare root never snapshotted');
assert.equal(motarroPathSnapshot(['mottaro', 'mottaro-other', 'mottaro-other-general']), null, 'general fallback never snapshotted');
assert.equal(
  motarroPathSnapshot(['mottaro', 'mottaro-crafts']),
  '["mottaro","mottaro-crafts"]',
  'meaningful path serialises to JSON id array',
);
assert.equal(parseStoredMotarroPath('["mottaro","nope"]', mottaroTree), null, 'stored path validated against tree');
const mottaroSrc = readSrc('lib/mottaro-category.mjs');
assert.match(mottaroSrc, /row\.mottaro_path/, 'inferMotarroPathFromRow reads persisted mottaro_path');
const bulkProductsSrc2 = readSrc('api/bulk-products.js');
assert.match(bulkProductsSrc2, /motarroPathSnapshot/, 'bulk move snapshots mottaro_path');
assert.match(bulkProductsSrc2, /destinationLabels/, 'bulk move returns destinationLabels');
const updateProductSrc2 = readSrc('api/update-product.js');
assert.match(updateProductSrc2, /snapshotMottaroPath/, 'single-product save refreshes mottaro_path');
assert.ok(readSrc('migrations/038_mottaro_path.sql').includes('mottaro_path'), 'migration 038 present');
console.log('✓ A4 mottaro_path persistence (derive → stored → fallback)');

// Shared Mottaro module — must stay byte-identical to the portal copy
const MOTTARO_SHARED_HASH = '702c264b95de85b8';
assert.equal(
  createHash('sha256').update(readSrc('lib/mottaro-category.mjs')).digest('hex').slice(0, 16),
  MOTTARO_SHARED_HASH,
  'lib/mottaro-category.mjs must stay byte-identical to Proto-Website-/lib/mottaro-category.mjs — edit both copies together and update the pinned hash in both qa-smoke-check.mjs files',
);
console.log('✓ Shared Mottaro module in sync with Proto-Website-');

// Shared placements module — must stay byte-identical to the portal copy
const PLACEMENTS_SHARED_HASH = 'a73d1bb627f01442';
assert.equal(
  createHash('sha256').update(readSrc('lib/placements.mjs')).digest('hex').slice(0, 16),
  PLACEMENTS_SHARED_HASH,
  'lib/placements.mjs must stay byte-identical to Proto-Website-/lib/placements.mjs — edit both copies together and update the pinned hash in both qa-smoke-check.mjs files',
);
console.log('✓ Shared placements module in sync with Proto-Website-');

// A5 — counts refresh after PM bulk move
const pmMoveBlock = pmEngineSrc2.match(/const confirmBulkMove = async[\s\S]*?finally \{\s*setMoveSaving\(false\);/)?.[0] || '';
assert.match(pmMoveBlock, /onRefreshTaxonomy\?\.\(\)/, 'PM bulk move refreshes taxonomy counts');
assert.match(pmMoveBlock, /setInStockCountsNonce/, 'PM bulk move refetches stock-filtered counts');
console.log('✓ A5 counts refresh after Product Manager move');

// Remove-from-category (Mottaro-only detach)
const bulkProductsRemoveSrc = readSrc('api/bulk-products.js');
assert.match(bulkProductsRemoveSrc, /action === 'removeFromCategory'/, 'bulk-products handles removeFromCategory');
assert.match(bulkProductsRemoveSrc, /bulkRemoveFromCategory/, 'removeFromCategory helper present');
assert.match(bulkProductsRemoveSrc, /Not a Motarro product/, 'removeFromCategory skips non-Motarro rows server-side');
assert.match(bulkProductsRemoveSrc, /motarroPathSnapshot\(deriveMotarroPathFromLabels/, 'removeFromCategory snapshots mottaro_path before clearing labels');
// The clear patch must clear every category column — '' for the NOT NULL
// columns (category, subcategory_one), null for the nullable deeper ones.
const removeFn = bulkProductsRemoveSrc.match(/const clearPatch = \{[\s\S]*?\};/)?.[0] || '';
assert.match(removeFn, /category: ''/, 'clearPatch clears category to empty string (NOT NULL column)');
assert.match(removeFn, /subcategory_one: ''/, 'clearPatch clears subcategory_one to empty string (NOT NULL column)');
for (const col of ['subcategory_two', 'subcategory_three', 'subcategory_four']) {
  assert.match(removeFn, new RegExp(`${col}: null`), `clearPatch nulls ${col}`);
}
const productsRemoveSrc = readSrc('src/lib/products.js');
assert.match(productsRemoveSrc, /export async function bulkRemoveFromCategory/, 'client bulkRemoveFromCategory present');
const pmRemoveSrc = readSrc('src/components/ProductManagerEngine.jsx');
assert.match(pmRemoveSrc, /selectionAllMottaro/, 'PM gates remove button on all-Mottaro selection');
assert.match(pmRemoveSrc, /canRemoveFromCategory/, 'PM computes remove-from-category visibility');
assert.match(pmRemoveSrc, /browsingMottaroTree/, 'remove button hidden inside the Mottaro virtual tree');
assert.match(pmRemoveSrc, /Remove from category/, 'remove-from-category button rendered');
assert.match(pmRemoveSrc, /pm-bulk-group--end/, 'bulk toolbar regrouped into clustered layout');
console.log('✓ Remove-from-category (Mottaro-only detach) + regrouped bulk toolbar');

// Floater sweep — archive live products that belong to no category
const floaterApiSrc = readSrc('api/archive-floaters.js');
assert.match(floaterApiSrc, /FLOATER_ARCHIVED_BY = 'floater'/, 'floaters tagged archived_by=floater');
assert.match(floaterApiSrc, /if \(isMotarroProduct\(row\)\) return null/, 'Motarro products excluded from floaters');
assert.match(floaterApiSrc, /if \(!cat\) return 'empty'/, 'empty category is a floater');
assert.match(floaterApiSrc, /if \(!deptLabels\.has\(cat\)\) return 'unmatched'/, 'unknown department is a floater');
assert.match(floaterApiSrc, /rpc\('archive_product', \{[\s\S]*p_by: FLOATER_ARCHIVED_BY/, 'floater execute uses archive_product RPC with the floater tag');
assert.match(pmRemoveSrc, /handleFloaterSweep/, 'PM has floater sweep handler');
assert.match(pmRemoveSrc, /Clean up floaters/, 'PM renders the Clean up floaters button');
assert.match(pmRemoveSrc, /floater: \{ label: 'Floater'/, 'Archive shows a Floater tag badge');
assert.match(productsRemoveSrc, /export async function archiveFloaters/, 'client archiveFloaters present');
console.log('✓ Floater sweep (archive uncategorised live products, tagged)');

// Product Manager review fixes (bulk handling + selection + counts sync)
// 1. "Select all (N)" must gather exactly what the list shows.
const selectAllBlock = pmRemoveSrc.match(/const selectAllInView = async[\s\S]*?setSelectingAll\(false\);/)?.[0] || '';
assert.match(selectAllBlock, /onlyInStock: status === 'live' && onlyInStock/, 'select-all mirrors the onlyInStock filter (no OOS leak)');
assert.match(selectAllBlock, /categoryPath: debouncedSearch \? \[\] : categoryPath/, 'select-all mirrors catalogue-wide search scope');
// 2. Category badges refresh after any catalogue mutation.
assert.match(readSrc('src/hooks/useCatalogMutations.js'), /dispatchEvent\(new CustomEvent\('proto-catalog-mutated'\)\)/, 'mutations signal catalogue change');
assert.match(pmRemoveSrc, /addEventListener\('proto-catalog-mutated'/, 'PM refreshes badges on catalogue mutation');
// 3. Page clamp so a shrunk total never strands the admin on a blank page.
assert.match(pmRemoveSrc, /if \(page > maxPage\) setPage\(maxPage\)/, 'PM clamps page when total shrinks');
// 4. Bulk client wrappers surface partial failures with SKUs and invalidate first.
assert.match(productsRemoveSrc, /function summarizeFailed/, 'shared failed-SKU summary helper');
assert.match(productsRemoveSrc, /restored, \$\{json\.failed\.length\} failed/, 'bulkUnarchive surfaces restore failures');
// 5. Delete reports one result per unique SKU (no double-count).
assert.match(bulkSrc, /one row per unique SKU/, 'bulkDelete dedupes results (accurate deleted count)');
assert.match(pmRemoveSrc, /onError: \(err\) => onShowToast\?\.\(err\.message \|\| 'Archive failed'/, 'single-row archive surfaces errors');
console.log('✓ Product Manager review fixes (select-all parity, badge sync, page clamp, bulk error surfacing)');

// Motarro subcategory delete — virtual node hide + product remap + reversible
const hiddenTree = injectMotarroIntoTree([
  { id: 'arts-and-crafts', label: 'Arts and Crafts', children: [{ id: 'crafts', label: 'Crafts', children: [] }] },
  { id: 'stationery', label: 'Stationery', children: [] },
], ['mottaro-crafts', 'mottaro-other-beads']);
const hiddenMottaroNode = hiddenTree.find((n) => n.id === 'mottaro');
assert.ok(!hiddenMottaroNode.children.some((c) => c.id === 'mottaro-crafts'), 'deleted Motarro branch pruned from tree');
assert.ok(!hiddenMottaroNode.children.find((c) => c.id === 'mottaro-other').children.some((c) => c.id === 'mottaro-other-beads'), 'deleted Motarro Other bucket pruned');
assert.deepEqual(
  inferMotarroPathFromRow({ title: 'MOTARRO bead', category: 'Beads' }, hiddenTree),
  ['mottaro', 'mottaro-other', 'mottaro-other-general'],
  'product in a deleted Motarro bucket remaps to Other›General',
);
const taxApiSrc = readSrc('api/taxonomy.js');
assert.match(taxApiSrc, /action === 'deleteNode' && isMottaroId/, 'taxonomy delete handles Motarro nodes');
assert.match(taxApiSrc, /archiveMotarroProductsUnderNode/, 'Motarro delete archives products under the node');
assert.match(taxApiSrc, /writeMottaroHiddenIds/, 'Motarro delete hides the virtual node');
assert.match(taxApiSrc, /action === 'restoreMottaroNode'/, 'Motarro delete is reversible (restore action)');
assert.match(taxonomyUtilsSrc, /export async function readMottaroHiddenIds/, 'hidden-ids store reader present');
assert.match(taxonomyUtilsSrc, /export async function archiveMotarroProductsUnderNode/, 'Motarro product archive helper present');
assert.match(pmRemoveSrc, /Restore deleted \(/, 'PM surfaces a Motarro restore control');
console.log('✓ Motarro subcategory delete (hide + archive products + reversible restore)');

// Production hardening (post-audit) — security, promo contract, lifecycle fixes

// The WATI↔Intercom relay webhooks were removed with the WhatsApp automations.
for (const f of ['api/wati-intercom.js', 'api/intercom-reply.js', 'api/wati-delivery-webhook.js']) {
  assert.ok(!existsSync(join(REPO_ROOT, f)), `${f} stays removed`);
}
console.log('✓ WhatsApp/WATI webhooks removed');

// Checkout promo must mirror into the portal validator file
const promoSrc = readSrc('api/checkout-promo.js');
assert.match(promoSrc, /promo-codes\.json/, 'checkout-promo mirrors into promo-codes.json');
assert.match(promoSrc, /discountPct: promo\.percent/, 'promo mirror maps percent to discountPct');
console.log('✓ Hardening: checkout promo reaches portal validator');

// Rename: tree save (optimistic lock) must run BEFORE product-row writes
const taxonomyApiSrc2 = readSrc('api/taxonomy.js');
const renameBlock = taxonomyApiSrc2.match(/if \(action === 'rename'\)[\s\S]*?\n    \}/)?.[0] || '';
assert.ok(
  renameBlock.indexOf('saveTaxonomy(next') < renameBlock.indexOf('renameProductsForNode('),
  'rename saves the tree before touching product rows',
);
// A product-write failure no longer just gets REPORTED — reporting still left
// the tree renamed and the rows on the old label, which is the state where the
// category renders empty and the admin has no way to retry (the UI no longer
// knows the old label). The rename is all-or-nothing now: on failure it puts
// both halves back and returns an error.
assert.match(renameBlock, /renameProductsForNode\(supabase, ctx, newLabel, oldLabel\)/, 'a failed rename moves the products back');
assert.match(renameBlock, /renameNodeLabel\(await loadTaxonomy\(\{ bypassCache: true \}\), id, oldLabel\)/, 'a failed rename restores the tree label');
assert.match(renameBlock, /resolveSingleNode\(tree, id\)/, 'rename refuses an id that matches more than one node');
assert.match(taxonomyApiSrc2, /pruneSortOrdersForNode/, 'deleteNode prunes orphaned sort orders');
console.log('✓ Hardening: rename ordering + sort-order pruning');

// Product Manager: Uncategorised entry + deleted-node filter reset
const pmSrc3 = readSrc('src/components/ProductManagerEngine.jsx');
assert.equal((pmSrc3.match(/showUncategorized=/g) || []).length, 2, 'both sidebars expose Uncategorised');
assert.match(pmSrc3, /setCategoryPath\(\[\]\);\s*\n\s*return;/, 'deleted-node path resets the category filter');
assert.doesNotMatch(pmSrc3, /path\[0\] \|\| tree\[0\]\?\.id/, 'make-live no longer defaults to the first category');
console.log('✓ Hardening: Uncategorised nav + deleted-node reset + make-live pick');

// Single-product moves resolve labels server-side (like bulk move)
const updateProductSrc3 = readSrc('api/update-product.js');
assert.match(updateProductSrc3, /resolveLabelsFromPathIds\(tree, categoryPathIds\)/, 'update-product resolves ids server-side');
assert.match(updateProductSrc3, /409[\s\S]*?Destination category changed/, 'update-product 409s on stale path');
const productsLibSrc = readSrc('src/lib/products.js');
assert.match(productsLibSrc, /body\.categoryPathIds = payload\.categoryPath/, 'client sends node ids, not labels');
assert.match(readSrc('src/pages/AdminPage.jsx'), /expectedUpdatedAt: editingProduct\.updatedAt/, 'editor sends optimistic-lock stamp');
console.log('✓ Hardening: single move is rename-safe + optimistic-locked');

// Canonical availability rule: keep_live_when_oos honoured, negative live
const { isPublishableOnWebsite: publishable } = await import('../lib/catalog-stock.mjs');
assert.equal(publishable({ stock_qty: 0 }), false, 'zero stock hidden');
assert.equal(publishable({ stock_qty: 0, keep_live_when_oos: true }), true, 'keep_live_when_oos overrides zero');
assert.equal(publishable({ stock_qty: -5 }), true, 'negative stock stays live');
assert.match(readSrc('api/_taxonomy-utils.js'), /keep_live_when_oos/, 'counts select keep_live_when_oos');
console.log('✓ Hardening: canonical availability rule');

// Misc lifecycle fixes
assert.match(readSrc('api/stock-actions.js'), /clean\.subcategory_one = clean\.category/, 'create defaults subcategory_one');
assert.match(readSrc('api/admin-customers.js'), /not\.\?found/, 'customer delete tolerates missing auth user');
const plSrc = readSrc('src/components/ProductLoaderPanel.jsx');
assert.doesNotMatch(plSrc, /setActiveTab\('advanced'\)/, 'no route to nonexistent advanced tab');
assert.match(readSrc('src/components/PricingPanel.jsx'), /Promise\.allSettled/, 'pricing reports partial failures');
assert.match(readSrc('src/pages/AdminPage.jsx'), /synced from ERP/, 'stock-on-hand field is read-only');
console.log('✓ Hardening: lifecycle fixes');

// Export all customers
const exportCustomersSrc = readSrc('src/lib/exportCustomers.js');
assert.match(exportCustomersSrc, /\['requests', 'regular'\]/, 'export unions requests + regular tabs');
assert.match(exportCustomersSrc, /rows\.length < pageSize/, 'export drains pagination');
assert.match(exportCustomersSrc, /r\.customer_code \|\| r\.account_code/, 'export maps both code columns');
assert.match(readSrc('src/pages/AdminPage.jsx'), /Export all customers/, 'export button rendered');
console.log('✓ Export all customers');

// Full-review pass — perf wins + serious-bug fixes
assert.match(readSrc('src/hooks/useDashboardStats.js'), /refresh: false/, 'dashboard stats no longer force a full recompute every load');
assert.doesNotMatch(readSrc('src/lib/taxonomyAdmin.js'), /counts=1\$\{stockParam\}&_=\$\{Date\.now/, 'category counts no longer bust the edge cache');
// The price guard moved into lib/catalogue-safety.mjs (PR #184): publish now
// derives price/stock through canonicalPublishValues, which blocks bad values.
assert.match(readSrc('api/product-loader-publish.js'), /canonicalPublishValues\(/, 'publish derives price/stock through the catalogue safety module');
assert.match(readSrc('lib/catalogue-safety.mjs'), /isDoubleVatSignature/, 'safety module guards against the double-VAT signature');
assert.match(readSrc('api/admin-customers.js'), /const justApproved =/, 'approval transition is detected against the pre-update row');
// LAUNCH RULE CHANGE: the welcome email fires ON APPROVAL (customers are
// promised a mail the moment they are approved; codes come later). The
// last_email_type guard stops double-sends when the code is assigned after.
assert.match(readSrc('api/admin-customers.js'), /justApproved \|\| \(justGotCode && neverWelcomed\)/, 'welcome email fires on approval, code-assignment only backfills the never-welcomed');
assert.match(readSrc('api/approve-customers-bulk.js'), /sendWelcomeApprovalEmail/, 'bulk approval also welcomes each customer');
assert.match(readSrc('api/admin-orders.js'), /Field writes commit only after every gate/, 'order field writes run after the workflow gates');
assert.match(readSrc('api/archive-floaters.js'), /deptLabels\.size === 0/, 'floater sweep refuses to run on an empty taxonomy');
assert.doesNotMatch(readSrc('src/lib/products.js'), /uploadDormantImageWithBase64/, 'dead image-gen helper removed');
assert.doesNotMatch(readSrc('src/components/ProductLoaderPanel.jsx'), /transform-product-image/, 'dead image-transform handler removed');
console.log('✓ Full-review pass (perf + serious-bug fixes)');

// Order / promo / broadcast security + correctness hardening
assert.match(readSrc('api/send-order-email.js'), /order link can only email the order's own customer/, 'order-token send is restricted to the order customer');
assert.match(readSrc('api/admin-orders.js'), /Not allowed to change .* from an order link/, 'order-token cannot write payment/total columns');
assert.match(readSrc('api/checkout-promo.js'), /Number\.isFinite\(rawPercent\)/, 'promo percent keeps a deliberate 0%');
console.log('✓ Order/promo/broadcast hardening');

// Adversarial-review fixes (multi-agent review of PRs #107-#122)
// 2. Email "Send test" always goes to the admin, never a typed customer
assert.doesNotMatch(readSrc('src/components/CustomerEmailModal.jsx'), /isSelected \? selectedEmails\[0\] : adminEmail/, 'test send never targets a selected customer');
// 3. ERP relink must not overwrite a name/description the admin typed in the same save
assert.match(readSrc('api/update-product.js'), /const adminSetName = patch\.title !== undefined \|\| patch\.original_description !== undefined/, 'relink detects admin-typed name/description');
assert.match(readSrc('api/update-product.js'), /matchedTitle && !adminSetName/, 'relink skips title overwrite when admin set it');
// 4. Image-replace identifier map registers SKUs first so a barcode cannot shadow a real SKU
assert.match(readSrc('src/lib/bulkImageReplace.js'), /Two passes so a SKU ALWAYS wins/, 'preflight builds SKU-first identifier map');
// 5. Folder progress label cannot exceed the total
assert.match(readSrc('src/components/productLoader/ProductLoaderFolder.jsx'), /Math\.min\(progress\.done \+ 1, progress\.total\)/, 'folder progress clamps to total');
// 6. Archive run tracks its own elapsed time
assert.match(readSrc('src/components/productLoader/ProductLoaderFolder.jsx'), /const archiveItems[\s\S]*?setElapsedMs\(Date\.now\(\) - start\)/, 'archive run updates elapsed time');
// 8. Chunk-reload guard clears after mount, not synchronously at boot
assert.match(readSrc('src/Root.jsx'), /useEffect\(\(\) => \{ clearChunkReloadGuard\(\); \}, \[\]\)/, 'chunk guard cleared post-mount in Root');
assert.doesNotMatch(readSrc('src/main.jsx'), /clearChunkReloadGuard\(\)/, 'main.jsx no longer clears the guard pre-mount');
console.log('✓ Adversarial-review fixes (6 bugs + robustness)');

// Add customer modal: eager (no stale-chunk reload) + scrollable so the button is always reachable
const adminSrcForModal = readSrc('src/pages/AdminPage.jsx');
assert.match(adminSrcForModal, /import AddCustomerModal from '\.\.\/components\/AddCustomerModal'/, 'AddCustomerModal is eager-imported (cannot trigger a chunk-reload)');
assert.doesNotMatch(adminSrcForModal, /const AddCustomerModal = lazyRetry/, 'AddCustomerModal is no longer lazy');
assert.match(readSrc('src/index.css'), /\.adm-modal--form \.adm-modal-body \{[\s\S]*?overflow-y: auto/, 'form modal body scrolls so the footer stays reachable');
console.log('✓ Add customer modal eager + scrollable');

// Add customer: styled inputs (adm-input is undefined) + pre-reg account_code must not be null (NOT NULL column)
const addCustSrc = readSrc('src/components/AddCustomerModal.jsx');
assert.doesNotMatch(addCustSrc, /className="adm-input"/, 'Add customer inputs use the real styled class, not the undefined adm-input');
assert.match(addCustSrc, /className="adm-field-input"/, 'Add customer inputs use adm-field-input');
// Every NOT NULL column in proto_active_customers gets a non-null value on manual add
const adminCustPreReg = readSrc('api/admin-customers.js');
assert.match(adminCustPreReg, /account_code: String\(b\.account_code \|\| ''\)\.trim\(\),/, 'pre-reg account_code is empty-string (not null)');
assert.match(adminCustPreReg, /name: name \|\| email,/, 'pre-reg name falls back to email (NOT NULL)');
assert.match(adminCustPreReg, /\? Number\(b\.sales_last_12_months\) \|\| 0 : 0,/, 'pre-reg sales_last_12_months defaults to 0 (NOT NULL)');
console.log('✓ Add customer: styled inputs + all NOT NULL columns handled');

// Product Loader: place a product at ANY subcategory depth and have it stick.
// Folder + single image use a full-depth cascading picker (CategoryPathSelect)
// and send a full categoryPath; the publish API writes every level via
// labelsToDbFields (subcategory_one..four + subcategory_extra).
assert.match(readSrc('api/product-loader-publish.js'), /labelsToDbFields\(cleanPath\)/, 'publish persists the full category path via labelsToDbFields (deep move sticks)');
assert.match(readSrc('src/lib/productLoaderApi.js'), /categoryPath,/, 'shared loader publish sends the full categoryPath for new products');
assert.match(readSrc('src/components/productLoader/CategoryPathSelect.jsx'), /subcategoryOptionsFromTree/, 'CategoryPathSelect cascades subcategories to any depth');
assert.match(readSrc('src/components/productLoader/ProductLoaderFolder.jsx'), /CategoryPathSelect/, 'folder loader uses the full-depth category picker');
assert.match(readSrc('src/components/productLoader/ProductLoaderSingleImage.jsx'), /CategoryPathSelect/, 'single-image loader uses the full-depth category picker');
console.log('✓ Product Loader: full-depth subcategory picker + deep-path persistence');

// Featured products — two faults reported together, one shared area.
//
// (1) It did not pick up another admin's changes. The app-wide query defaults
//     are staleTime 60s with no focus refetch and no interval, which suit the
//     heavy catalogue queries; for a short list of SKUs they mean a tab keeps
//     showing its own cached copy indefinitely.
// (2) Products could not be removed. Picks debounce for 2s while a remove
//     fires immediately, so a queued older payload — still containing the
//     product — could land last and write it straight back.
const featuredQueryBlock = featuredPanelSrc.match(/const featuredQuery = useQuery\(\{[\s\S]*?\}\);/)?.[0] || '';
assert.match(featuredQueryBlock, /staleTime: 0/, 'the featured list is never served stale');
assert.match(featuredQueryBlock, /refetchOnMount: 'always'/, 'the featured list refetches on mount');
assert.match(featuredQueryBlock, /refetchOnWindowFocus: true/, "another admin's change appears on focus");
assert.match(featuredPanelSrc, /const cancelQueuedSaves = useCallback/, 'queued saves can be cancelled');
assert.match(
  featuredPanelSrc.match(/const removeFeatured = useCallback[\s\S]*?\}, \[/)?.[0] || '',
  /cancelQueuedSaves\(\)/,
  'removing a product drops any debounced save that still contains it',
);
assert.match(featuredPanelSrc, /if \(data\.seq !== editSeqRef\.current\) return;/, 'a superseded save never repaints the list');
// The list itself must not wait on the full-catalogue fetch that only supplies
// names and images — that gate is what made the section look like it never
// loaded when the hydrate was slow or failed.
assert.doesNotMatch(
  featuredPanelSrc,
  /featuredQuery\.isLoading \|\| \(featuredItems\.length > 0 && hydrateQuery\.isLoading\)/,
  'the featured rows render without waiting for product details',
);
console.log('✓ Featured products: live across admins, removable, detail loads separately');

// Fulfilment "order flickers away": the first pick tick advances the order's
// status server-side (pending -> order in progress), and the next 30s/focus
// list refresh drops it from the tab the admin is working in — the open order
// vanished mid-fulfilment. The open order must stay pinned on screen with an
// explanation instead.
const adminPageForPin = readSrc('src/pages/AdminPage.jsx');
assert.match(adminPageForPin, /const \[pinnedOrder, setPinnedOrder\] = useState\(null\)/, 'an expanded order that leaves its tab is pinned');
assert.match(adminPageForPin, /__pinned: true/, 'the pinned row is prepended to the visible list');
assert.match(adminPageForPin, /if \(loading\) return; \/\/ only judge settled lists/, 'pinning never fires on a mid-refresh blank');
assert.match(adminPageForPin, /\}, \[orderTab, orderPage, orderSearchDebounced\]\)/, 'a deliberate tab/page/search change clears the pin');
assert.match(adminPageForPin, /advanced out of this tab/, 'the admin is told why the order moved');
console.log('✓ Fulfilment: an open order never silently vanishes from its tab');

// Payment / All-orders blink + choppy Customer Management: every 30s refresh
// used to replace identical state with new object identities, re-rendering
// every row and re-firing the per-row detail fetches; and loadCustomers had
// no sequencing or cache, so every tab/page/search change blanked the list
// and slow responses could land out of order.
assert.match(adminPageForPin, /const unchanged = prevEntry\?\.sig === sig/, 'an identical orders refresh changes nothing on screen');
assert.match(adminPageForPin, /const mergeMapIfChanged = /, 'per-order detail merges are no-ops when nothing changed');
assert.doesNotMatch(adminPageForPin, /\.then\(\(rows\) => setConfirmationSent\(\(prev\) => \(\{ \.\.\.prev, \.\.\.rows \}\)\)\)/, 'no unguarded confirmation merges remain');
assert.match(adminPageForPin, /customersReqSeqRef/, 'customer loads are sequenced');
assert.match(adminPageForPin, /if \(seq !== customersReqSeqRef\.current\) return; \/\/ superseded/, 'a stale customers response never repaints');
assert.match(adminPageForPin, /const \[customerListExpanded, setCustomerListExpanded\] = useState\(false\)/, 'customer lists open minimised');
assert.match(adminPageForPin, /Show all \$\{customerTotal\}/, 'a Show all toggle expands the full list');
console.log('✓ Orders refresh is render-stable; Customer Management sequenced, cached, minimisable');

console.log('\nAll smoke checks passed.');
