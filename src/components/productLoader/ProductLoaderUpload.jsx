import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Download,
  FolderOpen,
  FileSpreadsheet,
  ImagePlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
} from 'lucide-react';
import { exportBatchReportCsv } from '../../lib/parseIntakeFilename';
import { INTAKE_IMAGE_ACCEPT, inspectIntakeImageSelection } from '../../lib/intakeImageSelection';
import {
  archiveLoaderImageItem,
  correctLocalShipmentInstoreQuantity,
  importLocalShipmentToInstore,
  lookupFilenames,
  logPublishFailure,
  publishLoaderColourVariant,
  publishLoaderImageItem,
  reconcileInstoreLandedStock,
  syncLoaderColourVariantGroup,
} from '../../lib/productLoaderApi';
import { mergeReceivedStockSheets, parseReceivedStockSheet } from '../../lib/instoreShipmentSheet.js';
import { catalogueDisplayTitle, loaderCodeLabel } from '../../lib/productLoaderDisplay.js';
import LoaderCodeEllipsis from './LoaderCodeEllipsis.jsx';
import CategoryPathSelect, { normalizeCategoryPathValue } from './CategoryPathSelect';
import InstoreReview from './InstoreReview.jsx';
import { buildInstoreReview, normalizeReviewSku, uniqueInstoreRows } from '../../lib/instoreReview.js';
import { planSharedVariantImage } from '../../lib/sharedVariantImage.js';
import { loaderPriceSourceLabel } from '../../../lib/catalogue-price.mjs';
import { receivedInvoiceLinesToSellable } from '../../../lib/received-stock-unit.mjs';
import { applyAdminConfirmedGiftBagEach } from '../../../lib/admin-confirmed-gift-bag-unit.mjs';
import { applyAdminConfirmedBatchEach } from '../../../lib/admin-confirmed-batch-unit.mjs';
import { instoreCategoryAssignmentBlocker } from '../../../lib/instore-category-assignment.mjs';
import { instoreDuplicateBlocker } from '../../../lib/instore-duplicate-guard.mjs';
import { verifiedLiveInstoreStock } from '../../../lib/instore-live-stock.mjs';
import {
  clearProductLoaderUploadDraft,
  getProductLoaderUploadDraft,
  getProductLoaderUploadDraftRecovery,
  saveProductLoaderUploadDraft,
} from '../../lib/productLoaderUploadDraft.js';

/**
 * Upload tab — one place for both a single image and a whole folder. Each
 * filename is parsed as a product code (Positill code = text before the first
 * hyphen), looked up via the bridge, then published live or sent to archive.
 * A single image is just a one-row batch; the folder input and the image input
 * feed the exact same lookup → publish/archive pipeline. (Merges the former
 * "Single Image" + "Local Folder" tabs; the flow is unchanged.)
 */

function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

const GROUP_LABELS = {
  ready: 'Ready',
  needs_review: 'Needs Review',
  not_found: 'Not Found',
};

const WARNING_LABELS = {
  image_exists: 'Image already exists',
  low_stock: 'No available stock',
  price_zero: 'Price missing',
  price_suspect_ex_vat: 'Price looks EX VAT — check Positill (×1.15 lands on .00/.50)',
  price_source_cached: 'Live Positill unavailable — cached price needs review',
  selling_unit_required: 'No verified selling unit — resolve it in Positill before importing received stock',
  needs_category: 'Category required',
  not_in_catalog: 'Positill code not found',
  too_many_variant_images: 'Maximum 4 images per colour',
};

// Invoice quantities may legitimately make a landed item sellable before the
// normal stock receipt is posted. Cached, zero, suspect, or missing Positill
// product data must never be treated as an authoritative customer listing.
const INSTORE_LIVE_POSITILL_BLOCKERS = new Set([
  'price_source_cached',
  'price_zero',
  'price_suspect_ex_vat',
  'not_in_catalog',
  'selling_unit_required',
]);

function hasOnlySupplierPackQuantity(row, receiptLines) {
  const receipt = receivedStockSummary(row, receiptLines);
  return Boolean(receipt?.receiptAlreadySellable && receipt.receivedPacks > 0 && receipt.receivedPieces === 0);
}

function categoryPathLabels(tree, ids) {
  return (ids || []).map((id) => findNode(tree, id)?.label).filter(Boolean);
}

function rowDescription(row) {
  return row?.description || row?.sqlRow?.description || row?.sqlRow?.DESCRIPTION || row?.title || row?.sqlRow?.title || '';
}

function canImportToInstore(row, receiptLines, stockMode = 'received') {
  const allowedWarnings = stockMode === 'received' && hasOnlySupplierPackQuantity(row, receiptLines)
    ? new Set([...INSTORE_LIVE_POSITILL_BLOCKERS].filter((warning) => warning !== 'selling_unit_required'))
    : INSTORE_LIVE_POSITILL_BLOCKERS;
  return (row.group === 'ready' || row.group === 'needs_review')
    && Boolean(row.file && row.code)
    && row.positillSource === 'erp_sql'
    && Boolean(row.sqlRow)
    && !(row.warnings || []).some((warning) => allowedWarnings.has(warning));
}

function applyPositillDepartmentUnits(rows, sellingUnits) {
  if (!sellingUnits?.size) return rows;
  return rows.map((row) => {
    if (row?.unitsOfIssue || !row?.code) return row;
    const unit = String(sellingUnits.get(String(row.code).toUpperCase()) || '').trim();
    if (!unit) return row;
    return {
      ...row,
      unitsOfIssue: unit,
      canonicalSellingUnitKnown: true,
      sellingUnitSource: 'positill_department_invoice',
      warnings: (row.warnings || []).filter((warning) => warning !== 'selling_unit_required'),
    };
  });
}

// A disabled checkbox without a reason makes the red action look broken.
// Keep this explanation adjacent to the exact eligibility rule used by both
// the global selector and individual rows.
function instoreSelectionBlocker(row, receiptLines, categoryPath, stockMode = 'received') {
  if (!row?.file || !row?.code) return 'Image filename does not resolve to an exact SKU.';
  if (row.positillSource !== 'erp_sql' || !row.sqlRow) return 'Exact live Positill data is unavailable for this SKU.';
  const duplicate = instoreDuplicateBlocker({
    websiteStatus: row.websiteStatus,
    existingOnMainSite: row.existingOnMainSite,
    existingMainSiteLookupFailed: row.existingMainSiteLookupFailed,
    existingInstore: row.existingInstore,
    existingInstoreLookupFailed: row.existingInstoreLookupFailed,
  });
  if (duplicate) return duplicate;
  const categoryBlocker = instoreCategoryAssignmentBlocker({
    categoryPath,
    description: rowDescription(row),
  });
  if (categoryBlocker) return categoryBlocker === 'Choose an Instore destination before selecting this SKU.'
    ? 'Assign a destination to this selected product.' : categoryBlocker;
  const warning = (row.warnings || []).find((value) => INSTORE_LIVE_POSITILL_BLOCKERS.has(value)
    && !(stockMode === 'received' && value === 'selling_unit_required' && hasOnlySupplierPackQuantity(row, receiptLines)));
  if (warning) return WARNING_LABELS[warning] || warning;
  if (stockMode === 'positill_live') return verifiedLiveInstoreStock(row.sqlRow, row.code).blocker;
  const receipt = receivedStockSummary(row, receiptLines);
  if (!receipt) return 'No positive received quantity was found for this SKU in the Stock Received Excel.';
  if (receipt.sellableQty < 1) return `Received quantity is less than one ${receipt.unit.toLowerCase()}.`;
  return '';
}

function canSelectForInstore(row, receiptLines, categoryPath, stockMode = 'received') {
  return canImportToInstore(row, receiptLines, stockMode)
    && !instoreSelectionBlocker(row, receiptLines, categoryPath, stockMode)
    && row.status !== 'instore';
}

// A native disabled button cannot explain itself when it is tapped. Keep the
// gating rules in one place and render the *current* missing prerequisite next
// to the selection controls. This is especially important for landed
// shipments: a category, receipt file and selected eligible SKU are all
// intentionally required, but none should look like a broken red button.
function instoreImportBlockReason({
  instoreImportEnabled,
  instoreSchemaReady,
  instoreSchemaError,
  instoreStatus,
  receivedQuantities,
  stockMode,
  selectedInstoreCount,
}) {
  if (instoreSchemaError) return instoreSchemaError;
  if (instoreStatus === 'loading') return 'Checking Instore import status…';
  if (instoreStatus === 'error') return 'The Instore import status could not be confirmed. Retry the status check before continuing.';
  if (!instoreSchemaReady) return 'The Instore database check is not ready yet.';
  if (!instoreImportEnabled) return 'Importing is disabled in this Preview. Production is unchanged.';
  if (stockMode !== 'positill_live' && !receivedQuantities?.size) return 'Choose the Stock Received Excel to load confirmed quantities.';
  if (!selectedInstoreCount) return 'Select at least one eligible SKU to import.';
  return '';
}

function receivedStockSummary(row, receiptLines) {
  const lines = receiptLines?.get(String(row?.code || '').toUpperCase());
  if (!lines?.length) return null;
  let conversion;
  try {
    conversion = receivedInvoiceLinesToSellable(lines, row?.unitsOfIssue);
  } catch {
    return null;
  }
  const { unitsOfIssue: unit, unitSize, sellableQty, remainder } = conversion;
  return {
    receivedQty: conversion.receivedQty,
    receivedPieces: conversion.receivedPieces,
    receivedPacks: conversion.receivedPacks,
    receiptLines: lines,
    unitSize,
    sellableQty,
    remainder,
    unit,
    receiptAlreadySellable: conversion.receiptAlreadySellable,
    countLabel: /^(PACK|BAG|BOX|SET|CARD)(?: |$)/.test(unit)
      ? unit.split(' ')[0].toLowerCase()
      : unit === 'PAIR' ? 'pair'
        : unit === 'DOZEN' ? 'dozen'
          : 'unit',
  };
}

function sellableQuantityLabel(receipt) {
  if (!receipt) return '';
  const plural = receipt.sellableQty === 1 ? '' : 's';
  if (receipt.receiptAlreadySellable && receipt.unit === 'PACK') return `${receipt.sellableQty} pack${plural}`;
  if (/^(PACK|BAG|BOX|SET|CARD) \d+$/.test(receipt.unit)) {
    return `${receipt.sellableQty} ${receipt.countLabel}${plural} of ${receipt.unitSize}`;
  }
  return `${receipt.sellableQty} ${receipt.countLabel}${plural}`;
}

function receivedInvoiceLabel(receipt) {
  if (!receipt) return '';
  return receipt.receiptLines.map(({ qty, unit }) => `${qty} ${unit}`).join(' + ');
}

function hasReceivedStockOverride(row, receiptLines) {
  const receipt = receivedStockSummary(row, receiptLines);
  return Boolean(
    receipt?.sellableQty > 0
      && (row?.warnings || []).includes('low_stock')
      && canImportToInstore(row, receiptLines),
  );
}

function rowStatusLabel(row, { receivedStockOverride = false, receipt = null } = {}) {
  if (row.processError) return `${row.status || row.group} — ${row.processError}`;
  const warnings = (row.warnings || [])
    .filter((warning) => !(receivedStockOverride && warning === 'low_stock')
      && !(receipt?.receiptAlreadySellable && warning === 'selling_unit_required'))
    .map((warning) => WARNING_LABELS[warning] || warning);
  const status = receivedStockOverride
    ? `Stock available — received override (${sellableQuantityLabel(receipt)}${receipt.remainder ? `; ${receipt.remainder} piece${receipt.remainder === 1 ? '' : 's'} remainder` : ''})`
    : (row.status || row.group);
  return [status, ...warnings].filter(Boolean).join(' — ');
}

function isDraftRowFinished(row) {
  return row.status === 'done' || row.status === 'archived' || row.status === 'instore';
}

// Regular products are independent work units. All images for one recognised
// colour are one work unit so their four image slots publish atomically.
// Kept modest so a large folder doesn't overwhelm the serverless upload route.
const FOLDER_CONCURRENCY = 5;

/** Run `task` over items with a bounded number of concurrent workers. */
async function runWithConcurrency(items, limit, task) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await task(items[idx], idx);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

export default function ProductLoaderUpload({
  taxonomyTree,
  batchDefaultPathIds,
  setBatchDefaultPathIds,
  batchOverwrite,
  setBatchOverwrite,
  onShowToast,
  onProcessFiles,
  onPendingWorkChange,
  instoreOnly = false,
}) {
  const folderRef = useRef(null);
  const filesRef = useRef(null);
  const stockSheetRef = useRef(null);
  const unitSheetRef = useRef(null);
  // Never reuse a normal website-loader draft in the Instore-only path.
  const [items, setItems] = useState(() => instoreOnly ? [] : (getProductLoaderUploadDraft() || []));
  const [scanning, setScanning] = useState(false);
  const [scanSeconds, setScanSeconds] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stats, setStats] = useState({ published: 0, dormant: 0, failed: 0 });
  const [groupColourVariants, setGroupColourVariants] = useState(() => !instoreOnly);
  const [receivedStock, setReceivedStock] = useState(null);
  const [instoreStockMode, setInstoreStockMode] = useState('received');
  const [confirmSelectedPcsEach, setConfirmSelectedPcsEach] = useState(false);
  // A landed shipment must never default to publishing every eligible row.
  // The reviewer chooses the exact rows to make available in Instore.
  const [instoreSelected, setInstoreSelected] = useState(() => new Set());
  const [instoreReceipt, setInstoreReceipt] = useState([]);
  const [sharedPhotoFilename, setSharedPhotoFilename] = useState('');
  const [sharedVariantCodes, setSharedVariantCodes] = useState('');
  const importRunningRef = useRef(false);
  // Destination changes are explicit batch assignments, independent of selection.
  const [instoreDestinationIds, setInstoreDestinationIds] = useState(() => new Map());
  const [instoreImportEnabled, setInstoreImportEnabled] = useState(false);
  const [instoreSchemaReady, setInstoreSchemaReady] = useState(false);
  const [instoreSchemaError, setInstoreSchemaError] = useState('');
  const [instoreStatus, setInstoreStatus] = useState(instoreOnly ? 'loading' : 'enabled');
  const [instoreStatusAttempt, setInstoreStatusAttempt] = useState(0);
  const [sourceFiles, setSourceFiles] = useState(() => (
    instoreOnly ? [] : (getProductLoaderUploadDraft() || []).map((item) => item.file).filter(Boolean)
  ));
  const [draftRecovery, setDraftRecovery] = useState(() => (
    instoreOnly ? null : getProductLoaderUploadDraftRecovery()
  ));

  useEffect(() => {
    if (!scanning) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setScanSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const batchDefaultCategoryId = batchDefaultPathIds?.[0] || '';
  const batchDefaultPathLabels = useMemo(
    () => categoryPathLabels(taxonomyTree, batchDefaultPathIds),
    [batchDefaultPathIds, taxonomyTree],
  );
  const instoreDestinationLabels = useMemo(() => new Map(
    [...instoreDestinationIds].map(([filename, ids]) => {
      const requested = (Array.isArray(ids) ? ids : []).filter(Boolean);
      const normalized = normalizeCategoryPathValue(taxonomyTree, requested);
      const valid = normalized.length === requested.length && normalized.every((id, index) => id === requested[index]);
      return [filename, valid ? categoryPathLabels(taxonomyTree, normalized) : []];
    }),
  ), [instoreDestinationIds, taxonomyTree]);

  useEffect(() => {
    if (!instoreOnly) return undefined;
    let active = true;
    setInstoreStatus('loading');
    fetch('/api/nutstore-process')
      .then((response) => {
        if (!response.ok) throw new Error(`Instore status check failed (${response.status}).`);
        return response.json();
      })
      .then((status) => {
        if (!active) return;
        if (!status || typeof status !== 'object') throw new Error('The Instore status response was invalid.');
        setInstoreImportEnabled(Boolean(status?.instoreLandedImportEnabled));
        setInstoreSchemaReady(Boolean(status?.schemaReady));
        setInstoreSchemaError(String(status?.schemaError || ''));
        setInstoreStatus('confirmed');
      })
      .catch((err) => { if (active) { setInstoreImportEnabled(false); setInstoreSchemaReady(false); setInstoreSchemaError(String(err?.message || 'The Instore database check could not be reached.')); setInstoreStatus('error'); } });
    return () => { active = false; };
  }, [instoreOnly, instoreStatusAttempt]);

  const hasPendingWork = instoreOnly && (scanning || processing || instoreSelected.size > 0
    || (sourceFiles.length > 0 && items.length === 0)
    || Boolean(receivedStock?.quantities?.size || receivedStock?.sellingUnits?.size)
    || items.some((row) => !['instore', 'skipped', 'archived'].includes(row.status)));

  useEffect(() => { onPendingWorkChange?.(hasPendingWork); }, [hasPendingWork, onPendingWorkChange]);
  useEffect(() => () => onPendingWorkChange?.(false), [onPendingWorkChange]);

  useEffect(() => {
    if (!hasPendingWork) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasPendingWork]);

  useEffect(() => {
    if (!instoreOnly) return;
    // The landed-shipment state is isolated from the normal website-upload
    // draft. Switching workflows must never erase or reuse the other tab's work.
    setItems([]);
    setInstoreSelected(new Set());
    setInstoreDestinationIds(new Map());
    setConfirmSelectedPcsEach(false);
    setInstoreStockMode('received');
    setSourceFiles([]);
    setDraftRecovery(null);
  }, [instoreOnly]);

  const receivedQuantities = receivedStock?.quantities;
  const receiptLines = receivedStock?.receiptLines;
  const shipmentItems = useMemo(() => (instoreOnly
    ? items.map((row) => {
      const destination = instoreDestinationLabels.get(row.filename) || [];
      if (instoreStockMode === 'positill_live') return { ...row, instoreCategoryPath: destination };
      const giftBagRow = applyAdminConfirmedGiftBagEach(
          row,
          destination,
          receiptLines?.get(String(row?.code || '').toUpperCase()) || [],
        );
      return {
        ...applyAdminConfirmedBatchEach(
          giftBagRow,
          destination,
          receiptLines?.get(String(row?.code || '').toUpperCase()) || [],
          confirmSelectedPcsEach && instoreSelected.has(row.filename),
        ),
        instoreCategoryPath: destination,
      };
    })
    : items), [instoreOnly, items, confirmSelectedPcsEach, instoreSelected, instoreDestinationLabels, instoreStockMode, receiptLines]);
  const grouped = useMemo(() => ({
    ready: shipmentItems.filter((i) => i.group === 'ready' || (instoreOnly && instoreStockMode === 'received' && hasReceivedStockOverride(i, receiptLines))),
    needs_review: shipmentItems.filter((i) => i.group === 'needs_review' && !(instoreOnly && instoreStockMode === 'received' && hasReceivedStockOverride(i, receiptLines))),
    not_found: shipmentItems.filter((i) => i.group === 'not_found'),
  }), [instoreOnly, instoreStockMode, shipmentItems, receiptLines]);

  const summary = useMemo(() => ({
    found: items.length,
    matched: items.filter((i) => i.canPublish).length,
    ready: grouped.ready.length,
    needsReview: grouped.needs_review.length,
    notFound: grouped.not_found.length,
    published: stats.published,
    dormant: stats.dormant,
  }), [items, grouped, stats]);

  const handleFiles = async (fileList) => {
    const selection = inspectIntakeImageSelection(fileList);
    const files = selection.accepted;
    if (!files.length) {
      setError(selection.message);
      return;
    }
    setScanning(true);
    setScanSeconds(0);
    setSourceFiles(files);
    setInstoreReceipt([]);
    setError(selection.message);
    setItems([]);
    setInstoreSelected(new Set());
    setSharedPhotoFilename('');
    setSharedVariantCodes('');
    setInstoreDestinationIds(new Map());
    setConfirmSelectedPcsEach(false);
    setStats({ published: 0, dormant: 0, failed: 0 });
    try {
      // A landed folder can contain copies of a SKU in supplier subfolders.
      // One exact Instore SKU receives one deterministic first image.
      const uniqueByName = new Map();
      for (const file of [...files].sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name)))) {
        const key = String(file.name || '').trim().toUpperCase();
        if (!uniqueByName.has(key)) uniqueByName.set(key, file);
      }
      const uniqueFiles = instoreOnly ? [...uniqueByName.values()] : files;
      const lookedUp = await lookupFilenames(uniqueFiles.map((f) => f.name), uniqueFiles, {
        groupColourVariants: instoreOnly ? false : groupColourVariants,
        strictExact: instoreOnly,
      });
      const merged = instoreOnly ? applyPositillDepartmentUnits(lookedUp, receivedStock?.sellingUnits) : lookedUp;
      for (const row of merged) {
        if (row.file) row.previewUrl = URL.createObjectURL(row.file);
      }
      setItems(merged);
      if (!instoreOnly) {
        saveProductLoaderUploadDraft(merged);
        setDraftRecovery(getProductLoaderUploadDraftRecovery());
      }
      const duplicateCount = files.length - uniqueFiles.length;
      onShowToast?.(instoreOnly ? `Scanned ${uniqueInstoreRows(merged).length} unique products. Select products and assign their destinations.` : `Scanned ${merged.length} image${merged.length === 1 ? '' : 's'} — ${merged.filter((i) => i.group === 'ready').length} ready${duplicateCount ? `; ignored ${duplicateCount} duplicate image cop${duplicateCount === 1 ? 'y' : 'ies'}` : ''}`, 'success');
    } catch (err) {
      setError(err.message || 'Image scan failed');
    } finally {
      setScanning(false);
    }
  };

  const shareFamilyPhoto = async () => {
    if (scanning || processing) return;
    const source = items.find((row) => row.filename === sharedPhotoFilename && row.file && /^\d{10}$/.test(String(row.code || '')));
    if (!source) return setError('Choose the unresolved family photo first.');
    let plan;
    try {
      plan = planSharedVariantImage(source.code, source.filename, sharedVariantCodes,
        items.filter((row) => row.filename !== source.filename).map((row) => row.code));
    } catch (err) {
      return setError(err.message);
    }
    setScanning(true);
    setScanSeconds(0);
    setError('');
    try {
      // Renaming an in-memory copy gives the existing strict-exact lookup and
      // import path one real variant SKU per row. The local source is unchanged.
      const files = plan.map(({ filename }) => new File([source.file], filename, { type: source.file.type || 'image/jpeg' }));
      const lookedUp = await lookupFilenames(files.map((file) => file.name), files, {
        strictExact: true, groupColourVariants: false,
      });
      const expected = new Map(plan.map((entry) => [entry.filename, entry.code]));
      if (lookedUp.length !== plan.length || lookedUp.some((row) => expected.get(row.filename) !== row.code)
        || new Set(lookedUp.map((row) => row.filename)).size !== plan.length) {
        throw new Error('The live lookup did not return every exact variant. No family photo was assigned.');
      }
      const verified = applyPositillDepartmentUnits(lookedUp, receivedStock?.sellingUnits).map((row) => ({
        ...row,
        previewUrl: URL.createObjectURL(row.file),
        sharedFamilySource: source.filename,
        sourcePath: source.file.webkitRelativePath || source.filename,
      }));
      setItems((previous) => [...previous.filter((row) => row.filename !== source.filename), ...verified]);
      setSharedPhotoFilename('');
      setSharedVariantCodes('');
      onShowToast?.(`Reviewed ${verified.length} exact variants. Select only the eligible products to add; none were imported.`, 'success');
    } catch (err) {
      setError(err.message || 'Could not verify the exact variants. Nothing was imported.');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (instoreOnly) return;
    saveProductLoaderUploadDraft(items);
    setDraftRecovery(getProductLoaderUploadDraftRecovery());
  }, [instoreOnly, items]);

  const discardDraft = () => {
    if (!instoreOnly) clearProductLoaderUploadDraft();
    setItems([]);
    setInstoreSelected(new Set());
    setSharedPhotoFilename('');
    setSharedVariantCodes('');
    setInstoreDestinationIds(new Map());
    setConfirmSelectedPcsEach(false);
    setSourceFiles([]);
    setDraftRecovery(null);
    setStats({ published: 0, dormant: 0, failed: 0 });
    setError('');
  };

  const clearDraftAfterCompleteAction = () => {
    if (!instoreOnly) clearProductLoaderUploadDraft();
    setSourceFiles([]);
    setDraftRecovery(null);
  };

  const clearDraftIfEveryRowFinished = (completedFilenames) => {
    if (!items.every((row) => completedFilenames.has(row.filename) || isDraftRowFinished(row))) return;
    clearDraftAfterCompleteAction();
  };

  const publishItems = async (targetItems) => {
    const ready = targetItems.filter((i) => (i.group === 'ready' || i.group === 'needs_review') && i.file && i.code);
    if (!ready.length) return;
    const needsCategory = ready.some((i) => !i.websiteRow?.category);
    if (needsCategory && !batchDefaultCategoryId) {
      setError('Pick a default category for new products.');
      return;
    }

    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    const variantGroups = new Map();
    const workUnits = [];
    for (const row of ready) {
      if (!row.isColourVariant) {
        workUnits.push({ key: row.filename, rows: [row], isColourVariant: false });
        continue;
      }
      if (!variantGroups.has(row.code)) {
        const unit = { key: row.code, rows: [], isColourVariant: true };
        variantGroups.set(row.code, unit);
        workUnits.push(unit);
      }
      variantGroups.get(row.code).rows.push(row);
    }

    setProgress({ done: 0, total: workUnits.length, current: '' });
    let published = 0;
    let publishedImages = 0;
    let failed = 0;
    let done = 0;
    const publishedColourRows = [];

    await runWithConcurrency(workUnits, FOLDER_CONCURRENCY, async (unit) => {
      const filenames = new Set(unit.rows.map((row) => row.filename));
      setItems((prev) => prev.map((row) => (
        filenames.has(row.filename) ? { ...row, status: 'processing' } : row
      )));
      try {
        if (unit.isColourVariant) {
          await publishLoaderColourVariant(unit.rows, {
            taxonomyTree,
            findNode,
            defaultCategoryPathIds: batchDefaultPathIds,
            overwrite: batchOverwrite,
          });
          publishedColourRows.push(...unit.rows);
        } else {
          await publishLoaderImageItem(unit.rows[0], {
            taxonomyTree,
            findNode,
            defaultCategoryPathIds: batchDefaultPathIds,
            overwrite: batchOverwrite,
          });
        }
        published += 1;
        publishedImages += unit.rows.length;
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename) ? { ...row, status: 'done' } : row
        )));
      } catch (err) {
        failed += 1;
        await logPublishFailure({
          sku: unit.rows[0]?.code,
          filename: unit.rows.map((row) => row.filename).join(', '),
          reason: err.message,
        });
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename)
            ? { ...row, status: 'error', processError: err.message }
            : row
        )));
      } finally {
        done += 1;
        setProgress({ done, total: workUnits.length, current: unit.key });
        setElapsedMs(Date.now() - start);
      }
    });

    const groupedFamilies = new Map();
    for (const row of publishedColourRows) {
      if (!groupedFamilies.has(row.positillCode)) groupedFamilies.set(row.positillCode, []);
      groupedFamilies.get(row.positillCode).push(row);
    }
    const groupingErrors = [];
    for (const [baseCode, familyRows] of groupedFamilies) {
      try {
        await syncLoaderColourVariantGroup(familyRows);
      } catch (err) {
        groupingErrors.push(`${baseCode}: ${err.message}`);
        const filenames = new Set(familyRows.map((row) => row.filename));
        setItems((prev) => prev.map((row) => (
          filenames.has(row.filename)
            ? { ...row, status: 'review', processError: `Published; grouping needs review — ${err.message}` }
            : row
        )));
      }
    }

    setStats((s) => ({ ...s, published: s.published + published, failed: s.failed + failed }));
    setProgress({ done: workUnits.length, total: workUnits.length, current: '' });
    setElapsedMs(Date.now() - start);
    setProcessing(false);
    if (!failed && !groupingErrors.length) {
      clearDraftIfEveryRowFinished(new Set(ready.map((row) => row.filename)));
    }
    onShowToast?.(
      `Published ${published} product variant${published === 1 ? '' : 's'} from ${publishedImages} image${publishedImages === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}${groupingErrors.length ? `; ${groupingErrors.length} family group needs review` : ''}`,
      failed || groupingErrors.length ? 'warning' : 'success',
    );
  };

  const retryFailed = async () => {
    const failed = items.filter((i) => i.status === 'error');
    await publishItems(failed);
  };

  const reconcileLandedStock = async () => {
    if (!instoreImportEnabled || !instoreSchemaReady) return;
    setProcessing(true);
    setError('');
    try {
      const result = await reconcileInstoreLandedStock();
      const updated = (result.results || []).filter((row) => row.action === 'reconciled_to_positill').length;
      const waiting = (result.results || []).filter((row) => row.action === 'preserved_override').length;
      onShowToast?.(`Reconciled ${updated} landed item${updated === 1 ? '' : 's'} to Positill; ${waiting} still await GRV stock.`, 'success');
    } catch (err) {
      setError(err.message || 'Could not reconcile landed Instore stock with Positill.');
    } finally {
      setProcessing(false);
    }
  };

  const handleReceivedStockSheet = async (fileList) => {
    setError('');
    try {
      const parsed = await parseReceivedStockSheet(fileList);
      const merged = mergeReceivedStockSheets(receivedStock, parsed);
      setReceivedStock(merged);
      setItems((previous) => applyPositillDepartmentUnits(previous, merged.sellingUnits));
      const duplicateNote = merged.duplicates.length ? `; totalled ${merged.duplicates.length} repeated SKU${merged.duplicates.length === 1 ? '' : 's'}` : '';
      const unitNote = merged.sellingUnits.size ? `; ${merged.sellingUnits.size} Positill selling units loaded` : '';
      onShowToast?.(`Loaded ${merged.quantities.size} received SKUs across ${merged.quantityFiles.length} Stock Received file${merged.quantityFiles.length === 1 ? '' : 's'}${duplicateNote}${unitNote}`, 'success');
    } catch (err) {
      setError(err.message || 'Could not read the Stock Received Excel file.');
    }
  };

  const handleDepartmentUnitSheet = async (fileList) => {
    setError('');
    if (!receivedStock?.quantities?.size) {
      setError('Choose the Stock Received Excel before adding the Positill unit invoice.');
      return;
    }
    try {
      const parsed = await parseReceivedStockSheet(fileList, { requireQuantities: false });
      if (!parsed.sellingUnits.size) {
        throw new Error('No Positill selling units were found. Choose the department invoice with CODE, UNIT and Department columns.');
      }
      const merged = mergeReceivedStockSheets(receivedStock, parsed);
      setReceivedStock(merged);
      setItems((previous) => applyPositillDepartmentUnits(previous, merged.sellingUnits));
      onShowToast?.(`Loaded ${parsed.sellingUnits.size} Positill selling units from ${parsed.departmentFiles.join(', ')}`, 'success');
    } catch (err) {
      setError(err.message || 'Could not read the Positill unit invoice.');
    }
  };

  const importToInstore = async () => {
    if (importRunningRef.current || scanning || processing) return;
    if (!instoreImportEnabled) return setError('Adding products is disabled in this Preview.');
    if (!instoreSchemaReady) return setError('The Instore database check is not ready. Importing remains disabled.');
    if (instoreStockMode === 'received' && !receivedStock?.quantities?.size) return setError('Upload the Stock Received Excel so every SKU has a confirmed quantity.');
    const rows = uniqueInstoreRows(shipmentItems).filter((row) => instoreSelected.has(row.filename));
    if (!rows.length) return setError('Select at least one product to add to Instore.');
    const blockedRow = rows.find((row) => !canSelectForInstore(row, receiptLines, row.instoreCategoryPath, instoreStockMode));
    if (blockedRow) return setError(`${loaderCodeLabel(blockedRow)} cannot be sent: ${instoreSelectionBlocker(blockedRow, receiptLines, blockedRow.instoreCategoryPath, instoreStockMode) || 'review its destination and source data'}`);
    importRunningRef.current = true;
    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    setProgress({ done: 0, total: rows.length, current: '' });
    const outcomes = new Map();
    let done = 0;
    try {
      await runWithConcurrency(rows, 2, async (row) => {
        const sku = normalizeReviewSku(row.code);
        setItems((previous) => previous.map((item) => item.filename === row.filename ? { ...item, status: 'processing' } : item));
        try {
          const categoryPath = row.instoreCategoryPath || [];
          const result = await importLocalShipmentToInstore(row, {
            category: categoryPath[0] || '', categoryPath, stockMode: instoreStockMode,
            ...(instoreStockMode === 'received' ? { receiptLines: receivedStockSummary(row, receiptLines).receiptLines } : {}),
          });
          if (result?.ok !== true || normalizeReviewSku(result.sku) !== sku || !['instore_import', 'instore_skipped'].includes(result.action)) {
            throw new Error('The server did not confirm this product was added. Refresh live lookup before retrying.');
          }
          const skipped = result.action === 'instore_skipped';
          outcomes.set(sku, { sku, outcome: skipped ? 'skipped' : 'added',
            reason: skipped ? result.message || 'Already listed; no duplicate was created.' : 'Confirmed added to Instore.',
          });
          setInstoreSelected((previous) => { const next = new Set(previous); next.delete(row.filename); return next; });
          setItems((previous) => previous.map((item) => normalizeReviewSku(item.code) === sku ? {
            ...item, status: skipped ? 'skipped' : 'instore', processError: '',
            existingInstore: !skipped || result.reason === 'already_in_instore' || item.existingInstore,
            existingOnMainSite: result.reason === 'already_on_main_site' || item.existingOnMainSite,
          } : item));
        } catch (err) {
          outcomes.set(sku, { sku, outcome: 'failed', reason: err.message || 'Import failed. Retry live lookup before trying again.' });
          setItems((previous) => previous.map((item) => item.filename === row.filename ? { ...item, status: 'error', processError: err.message } : item));
        } finally {
          done += 1;
          setProgress({ done, total: rows.length, current: row.filename });
          setElapsedMs(Date.now() - start);
        }
      });
      const results = rows.map((row) => outcomes.get(normalizeReviewSku(row.code)));
      setInstoreReceipt((previous) => [...previous.filter((entry) => !outcomes.has(entry.sku)), ...results]);
      if (!results.some((entry) => entry.outcome === 'failed')) clearDraftAfterCompleteAction();
      onShowToast?.(`Added ${results.filter((entry) => entry.outcome === 'added').length}; skipped ${results.filter((entry) => entry.outcome === 'skipped').length}; failed ${results.filter((entry) => entry.outcome === 'failed').length}.`, results.some((entry) => entry.outcome === 'failed') ? 'warning' : 'success');
    } finally {
      importRunningRef.current = false;
      setProcessing(false);
    }
  };

  const refreshInstoreLookup = async (retryFailedOnly = false) => {
    if (scanning || processing) return;
    const failedSkus = new Set(instoreReceipt.filter((entry) => entry.outcome === 'failed').map((entry) => entry.sku));
    const targets = uniqueInstoreRows(items).filter((row) => retryFailedOnly ? failedSkus.has(normalizeReviewSku(row.code)) : row.status !== 'instore');
    if (!targets.length) return;
    setScanning(true);
    setScanSeconds(0);
    setError('');
    try {
      const refreshed = await lookupFilenames(targets.map((row) => row.filename), targets.map((row) => row.file), { strictExact: true, groupColourVariants: false });
      const freshByName = new Map(applyPositillDepartmentUnits(refreshed, receivedStock?.sellingUnits).map((row) => [row.filename, row]));
      // A missing response is a failed verification, never permission to reuse stale stock.
      setItems((previous) => previous.map((row) => {
        if (!targets.some((target) => target.filename === row.filename)) return row;
        const fresh = freshByName.get(row.filename);
        return fresh ? { ...fresh, file: row.file, previewUrl: row.previewUrl,
          sharedFamilySource: row.sharedFamilySource, sourcePath: row.sourcePath, status: '', processError: '' }
          : { ...row, positillSource: 'unavailable', lookupError: true, processError: 'Live lookup did not return this SKU.' };
      }));
      if (retryFailedOnly) setInstoreSelected(new Set(targets.map((row) => row.filename)));
    } catch (err) {
      setError(err.message || 'Live lookup failed. Import remains blocked until verification succeeds.');
      setItems((previous) => previous.map((row) => targets.some((target) => target.filename === row.filename)
        ? { ...row, positillSource: 'unavailable', lookupError: true } : row));
    } finally {
      setScanning(false);
    }
  };

  const correctInstoreReceivedQuantities = async () => {
    if (!instoreImportEnabled) return setError('Landed Instore quantity correction is disabled in this Preview.');
    if (!instoreSchemaReady) return setError('The Instore database check is not ready. Quantity correction remains disabled.');
    if (!receivedStock?.quantities?.size) return setError('Upload the Stock Received Excel so every SKU has a confirmed quantity.');

    const selectedRows = shipmentItems.filter((row) => instoreSelected.has(row.filename));
    const byCode = new Map();
    for (const row of selectedRows) {
      const receipt = receivedStockSummary(row, receivedStock.receiptLines);
      if (!canImportToInstore(row, receivedStock.receiptLines) || !receipt || receipt.sellableQty < 1) continue;
      const existing = byCode.get(row.code);
      if (!existing || Number(row.imageSlot || 1) < Number(existing.imageSlot || 1)) byCode.set(row.code, row);
    }
    const rows = [...byCode.values()];
    if (!rows.length) return setError('Select at least one exact Positill row with a positive received quantity.');

    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    setProgress({ done: 0, total: rows.length, current: '' });
    let corrected = 0;
    let failed = 0;
    let done = 0;
    await runWithConcurrency(rows, 2, async (row) => {
      setItems((previous) => previous.map((item) => (item.filename === row.filename ? { ...item, status: 'processing' } : item)));
      try {
        await correctLocalShipmentInstoreQuantity(row, { receiptLines: receivedStockSummary(row, receivedStock.receiptLines).receiptLines });
        corrected += 1;
        setItems((previous) => previous.map((item) => (item.code === row.code ? { ...item, status: 'instore', processError: '' } : item)));
      } catch (err) {
        failed += 1;
        setItems((previous) => previous.map((item) => (item.filename === row.filename ? { ...item, status: 'error', processError: err.message } : item)));
      } finally {
        done += 1;
        setProgress({ done, total: rows.length, current: row.filename });
        setElapsedMs(Date.now() - start);
      }
    });
    setProcessing(false);
    onShowToast?.(`Corrected received quantities for ${corrected} existing Instore item${corrected === 1 ? '' : 's'}${failed ? `; ${failed} need review` : ''}`, failed ? 'warning' : 'success');
  };

  // Same rule as the Nutstore flow: images whose code has no match still go
  // to the archive as placeholders; fixing the code later re-links the data.
  const archiveItems = async (targetItems) => {
    const rows = targetItems.filter((i) => i.file && i.code && !i.parseError);
    if (!rows.length) return;
    setProcessing(true);
    setError('');
    const start = Date.now();
    setStartedAt(start);
    setProgress({ done: 0, total: rows.length, current: '' });
    let archived = 0;
    let failed = 0;
    let done = 0;
    await runWithConcurrency(rows, FOLDER_CONCURRENCY, async (row) => {
      setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'processing' } : r)));
      try {
        await archiveLoaderImageItem(row);
        archived += 1;
        setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'archived' } : r)));
      } catch (err) {
        failed += 1;
        setItems((prev) => prev.map((r) => (r.filename === row.filename ? { ...r, status: 'error', processError: err.message } : r)));
      } finally {
        done += 1;
        setProgress({ done, total: rows.length, current: row.filename });
        setElapsedMs(Date.now() - start);
      }
    });
    setProgress({ done: rows.length, total: rows.length, current: '' });
    setElapsedMs(Date.now() - start);
    setProcessing(false);
    setStats((s) => ({ ...s, dormant: s.dormant + archived, failed: s.failed + failed }));
    if (!failed) clearDraftIfEveryRowFinished(new Set(rows.map((row) => row.filename)));
    onShowToast?.(`Archived ${archived}${failed ? `, ${failed} failed` : ''}`, failed ? 'warning' : 'success');
  };

  const exportReport = () => {
    const csv = exportBatchReportCsv(items, summary);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `product-loader-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderGroup = (key) => {
    const rows = grouped[key];
    if (!rows.length) return null;
    return (
      <section key={key} className="pl-folder-group">
        <h4>{GROUP_LABELS[key]} <span className="adm-muted">({rows.length})</span></h4>
        <div className="pl-folder-table-wrap">
          <table className="pl-folder-table">
            <colgroup>
              <col style={{ width: 48 }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: 88 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Preview</th>
                <th>SKU</th>
                <th>Positill / Colour</th>
                <th>Description</th>
                <th>Price incl. VAT</th>
                <th>Slot</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.filename}>
                  <td>{row.previewUrl ? <img src={row.previewUrl} alt="" className="pl-folder-thumb" /> : '—'}</td>
                  <td className="pl-table-clip"><LoaderCodeEllipsis value={loaderCodeLabel(row)} fill /></td>
                  <td className="pl-table-clip">
                    {row.isColourVariant ? (
                      <span>{row.positillCode}<br /><strong>{row.variantLabel}</strong></span>
                    ) : '—'}
                  </td>
                  <td className="pl-table-clip">
                    <LoaderCodeEllipsis value={catalogueDisplayTitle(row)} strong={false} fill />
                  </td>
                  <td>R {Number(row.price || 0).toFixed(2)}<br /><span className="adm-muted">{row.priceSourceLabel || loaderPriceSourceLabel(row.priceSource)}</span></td>
                  <td>{row.imageSlot}</td>
                  <td className={row.status === 'error' ? 'pl-error' : ''}>{rowStatusLabel(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const busy = scanning || processing;
  const unresolvedFamilyPhotos = instoreOnly ? items.filter((row) => row.file && row.group === 'not_found' && /^\d{10}$/.test(String(row.code || ''))) : [];
  const reviewEntries = instoreOnly ? buildInstoreReview(shipmentItems, {
    isReady: (row) => canSelectForInstore(row, receiptLines, row.instoreCategoryPath, instoreStockMode),
    getBlocker: (row) => instoreSelectionBlocker(row, receiptLines, row.instoreCategoryPath, instoreStockMode),
  }) : [];
  const selectedInstoreEntries = reviewEntries.filter((entry) => instoreSelected.has(entry.key));
  const selectedInstoreSkuCount = selectedInstoreEntries.length;
  const importBlockReason = instoreOnly ? instoreImportBlockReason({
    instoreImportEnabled, instoreSchemaReady, instoreSchemaError, instoreStatus, receivedQuantities,
    stockMode: instoreStockMode, selectedInstoreCount: selectedInstoreSkuCount,
  }) || (selectedInstoreEntries.some((entry) => entry.state !== 'ready') ? 'Resolve the selected products that need attention before adding.' : '') : '';

  const instoreStockInfo = (row) => {
    if (instoreStockMode === 'positill_live') {
      const stock = verifiedLiveInstoreStock(row.sqlRow, row.code);
      const unit = String(stock.unitsOfIssue || '').toLowerCase();
      const unitLabel = unit === 'each' ? 'item' : unit;
      const label = stock.blocker ? 'Stock unavailable' : /^(item|card|pack|bag|box|set|pair|dozen)$/.test(unitLabel)
        ? `${stock.sellableQty} ${unitLabel}${stock.sellableQty !== 1 ? unitLabel === 'box' ? 'es' : 's' : ''} available`
        : `${stock.sellableQty} selling units available (${stock.unitsOfIssue})`;
      return { label, details: stock.blocker || `Positill unit: ${stock.unitsOfIssue}; ${stock.onhand} on hand − ${stock.booked} booked. Minimum 10 available selling units.` };
    }
    const receipt = receivedStockSummary(row, receiptLines);
    const received = receiptLines?.get(normalizeReviewSku(row.code));
    return { label: receipt ? `${sellableQuantityLabel(receipt)} received` : 'Selling quantity needs verification',
      details: receipt ? `${receivedInvoiceLabel(receipt)} received. Selling unit: ${receipt.unit}.${receipt.remainder ? ` ${receipt.remainder} PCS remainder.` : ''}${String(row.sellingUnitSource || '').startsWith('admin_confirmed_') ? ' Admin-confirmed EACH.' : ''}`
        : received?.length ? `${received.map(({ qty, unit }) => `${qty} ${unit}`).join(' + ')} received; verify the selling unit.` : 'No received quantity found. Choose the Stock Received Excel.' };
  };

  if (instoreOnly) return <div className="pl-section pl-section--instore">
    <span className="ir-step">STEP 1</span><h3>Choose images</h3>
    <p className="pl-section-note">Choose your stock source and images, then select products and assign their Instore destinations.</p>
    <fieldset className="pl-stock-source-choice"><legend>Stock source for this import</legend>
      <label className="pl-check"><input type="radio" name="instore-stock-source" checked={instoreStockMode === 'received'} disabled={busy} onChange={() => { setInstoreStockMode('received'); setInstoreSelected(new Set()); setInstoreDestinationIds(new Map()); setInstoreReceipt([]); }} />New receipt — Stock Received Excel</label>
      <label className="pl-check"><input type="radio" name="instore-stock-source" checked={instoreStockMode === 'positill_live'} disabled={busy} onChange={() => { setInstoreStockMode('positill_live'); setInstoreSelected(new Set()); setInstoreDestinationIds(new Map()); setInstoreReceipt([]); }} />Already GRV’d — live Positill stock</label>
      <span className="adm-muted">{instoreStockMode === 'positill_live' ? 'Live Positill stock: no Stock Received Excel needed. Exact SKU, selling unit and at least 10 available selling units are required.' : 'Use quantities from this receipt. PKS remain sellable packs; PCS require a verified selling unit.'}</span>
    </fieldset>
    <div className="pl-action-row">
      <button type="button" className="adm-btn-red" disabled={busy} onClick={() => filesRef.current?.click()}><ImagePlus size={16} />Choose image(s)</button>
      <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => folderRef.current?.click()}><FolderOpen size={16} />Choose image folder</button>
      {instoreStockMode === 'received' && <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => stockSheetRef.current?.click()}><FileSpreadsheet size={16} />{receivedStock ? `Stock Received: ${receivedStock.quantities.size} SKUs` : 'Choose Stock Received Excel'}</button>}
      {instoreStockMode === 'received' && <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => unitSheetRef.current?.click()}><FileSpreadsheet size={16} />Add Positill unit invoice</button>}
    </div>
    {unresolvedFamilyPhotos.length > 0 && <details className="pl-shared-family-photo">
      <summary>Photo shows several colour variants?</summary>
      <p>Use one group photo as the main image for exact Positill variants. Enter their full codes; the loader checks each variant separately. This does not create the unsuffixed code, change Positill, or use the same stock quantity for every colour.</p>
      <label>Group photo
        <select value={sharedPhotoFilename} disabled={busy} onChange={(event) => setSharedPhotoFilename(event.target.value)}>
          <option value="">Choose a photo</option>
          {unresolvedFamilyPhotos.map((row) => <option key={row.filename} value={row.filename}>{row.filename}</option>)}
        </select>
      </label>
      <label>Exact variant codes
        <input type="text" value={sharedVariantCodes} disabled={busy} onChange={(event) => setSharedVariantCodes(event.target.value)} placeholder="8626000775B, 8626000775H, ..." />
      </label>
      <button type="button" className="adm-btn-ghost" disabled={busy || !sharedPhotoFilename || !sharedVariantCodes.trim()} onClick={() => void shareFamilyPhoto()}>Check and stage these variants</button>
      <small>Instore accepts one main image here. Other group photos remain unassigned; existing catalogue images are never replaced.</small>
    </details>}
    <input ref={filesRef} type="file" accept={INTAKE_IMAGE_ACCEPT} multiple hidden onChange={(event) => { void handleFiles(event.target.files); event.target.value = ''; }} />
    <input ref={folderRef} type="file" accept={INTAKE_IMAGE_ACCEPT} multiple webkitdirectory="" directory="" hidden onChange={(event) => { void handleFiles(event.target.files); event.target.value = ''; }} />
    <input ref={stockSheetRef} type="file" accept=".xlsx,.xls,.csv" multiple hidden onChange={(event) => { void handleReceivedStockSheet(event.target.files); event.target.value = ''; }} />
    <input ref={unitSheetRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(event) => { void handleDepartmentUnitSheet(event.target.files); event.target.value = ''; }} />
    {error && <p className="pl-error" role="alert">{error}</p>}
    {busy && <p role="status">{scanning
      ? `Checking live product data for ${sourceFiles.length} image${sourceFiles.length === 1 ? '' : 's'}… ${scanSeconds}s elapsed. No products are imported during this check.`
      : `Processed ${progress.done} of ${progress.total} products`}</p>}
    {instoreStockMode === 'received' && items.length > 0 && <details><summary>Received-stock unit confirmations</summary>
      <p>Gift Bags in their approved destination use the separately recorded Gift Bags EACH rule. A Positill department invoice can supply a missing selling unit. Positill is never changed.</p>
      <label className="pl-check"><input type="checkbox" disabled={busy} checked={confirmSelectedPcsEach} onChange={(event) => setConfirmSelectedPcsEach(event.target.checked)} />Confirm selected PCS items are EACH for this shipment</label>
      <p>This explicit confirmation applies only to selected eligible numeric SKUs with PCS-only receipts and resets with a new folder.</p>
    </details>}
    <InstoreReview entries={reviewEntries} selected={instoreSelected} busy={busy} importEnabled={instoreImportEnabled}
      statusState={instoreSchemaError ? 'error' : instoreStatus === 'confirmed' && !instoreImportEnabled ? 'disabled' : instoreStatus}
      onRetryStatus={() => { setInstoreSchemaError(''); setInstoreStatusAttempt((attempt) => attempt + 1); }}
      importBlockReason={importBlockReason} stockMode={instoreStockMode} stockInfo={instoreStockInfo}
      categoryPicker={<CategoryPathSelect taxonomyTree={taxonomyTree} value={batchDefaultPathIds} onChange={setBatchDefaultPathIds} mainLabel="Assign Instore category" />}
      canAssignCategory={Boolean(batchDefaultPathLabels.length)}
      onAssignCategory={() => setInstoreDestinationIds((previous) => { const next = new Map(previous); for (const entry of selectedInstoreEntries) next.set(entry.key, [...batchDefaultPathIds]); return next; })}
      onSelect={(keys, checked) => setInstoreSelected((previous) => { const next = new Set(previous); for (const key of keys) { if (checked) next.add(key); else next.delete(key); } return next; })}
      onClearSelection={() => setInstoreSelected(new Set())} onImport={importToInstore} onRefresh={() => void refreshInstoreLookup()}
      receipt={instoreReceipt} onRetryFailed={() => void refreshInstoreLookup(true)} />
    {items.length > 0 && <details style={{ marginTop: 18 }}><summary>Stock maintenance and reports</summary><div className="pl-action-row">
      {instoreStockMode === 'received' && <button type="button" className="adm-btn-ghost" disabled={busy || Boolean(importBlockReason)} onClick={() => void correctInstoreReceivedQuantities()}>Correct selected received quantities ({selectedInstoreSkuCount})</button>}
      <button type="button" className="adm-btn-ghost" disabled={busy || !instoreImportEnabled || !instoreSchemaReady} onClick={() => void reconcileLandedStock()}>Reconcile GRV stock</button>
      <button type="button" className="adm-btn-ghost" onClick={exportReport}><Download size={14} />Export Report</button>
    </div></details>}
  </div>;

  return (
    <div className="pl-section">
      <p className="pl-section-note">
        Upload a single image or a whole folder of supplier images. Each filename is parsed as a
        product code and looked up automatically via the bridge. Recognised colour suffixes create
        website variants under one Positill product; for example, 8621000002-WHT becomes White.
      </p>

      <div className="pl-action-row">
        <button type="button" className="adm-btn-red" disabled={busy} onClick={() => !busy && filesRef.current?.click()}>
          {scanning ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />} Choose image(s)
        </button>
        <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => !busy && folderRef.current?.click()}>
          <FolderOpen size={16} /> Choose image folder
        </button>
        {onProcessFiles && sourceFiles.length > 0 && (
          <button type="button" className="adm-btn-ghost" disabled={busy} onClick={() => onProcessFiles(sourceFiles)}>
            <Sparkles size={14} /> Improve selected ({sourceFiles.length})
          </button>
        )}
        <input ref={filesRef} type="file" accept={INTAKE_IMAGE_ACCEPT} multiple hidden onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
        <input ref={folderRef} type="file" accept={INTAKE_IMAGE_ACCEPT} multiple webkitdirectory="" directory="" hidden onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
        <label className="pl-check">
          <input
            type="checkbox"
            checked={groupColourVariants}
            disabled={busy}
            onChange={(event) => setGroupColourVariants(event.target.checked)}
          />
          Group recognised colour suffixes as variants
        </label>
      </div>

      {error && <p className="pl-error">{error}</p>}

      {!items.length && draftRecovery?.count > 0 && (
        <div className="pl-draft-notice">
          <strong>Upload draft saved in this browser</strong>
          <span>{draftRecovery.count} image{draftRecovery.count === 1 ? '' : 's'} were selected before refresh; it was never published. Choose the file again to continue.</span>
          <button type="button" className="adm-btn-ghost" onClick={discardDraft}>Discard draft</button>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="pl-summary-dashboard">
            <div><strong>{summary.found}</strong><span>Images Found</span></div>
            <div><strong>{summary.matched}</strong><span>Matched</span></div>
            <div><strong>{new Set(items.filter((item) => item.isColourVariant).map((item) => item.code)).size}</strong><span>Colour Variants</span></div>
            <div><strong>{summary.published}</strong><span>Published</span></div>
            <div><strong>{summary.dormant}</strong><span>Dormant</span></div>
            <div><strong>{summary.needsReview}</strong><span>Needs Review</span></div>
            <div><strong>{summary.notFound}</strong><span>Not Found</span></div>
            <div><strong>{elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : '—'}</strong><span>Elapsed</span></div>
          </div>

          {processing && (
            <div className="pl-progress">
              <div className="pl-progress-bar" style={{ width: `${pct}%` }} />
              <span>Processing {Math.min(progress.done + 1, progress.total)}/{progress.total}{progress.current ? ` — ${progress.current}` : ''}</span>
            </div>
          )}

          {renderGroup('ready')}
          {renderGroup('needs_review')}
          {renderGroup('not_found')}

          <div className="pl-inline-fields">
            <CategoryPathSelect
              taxonomyTree={taxonomyTree}
              value={batchDefaultPathIds}
              onChange={setBatchDefaultPathIds}
              mainLabel="Default category (new products)"
            />
            <label className="pl-check">
              <input type="checkbox" checked={batchOverwrite} onChange={(e) => setBatchOverwrite(e.target.checked)} />
              Replace images if slot already filled
            </label>
          </div>

          <div className="pl-action-row">
            <button type="button" className="adm-btn-red" disabled={processing || scanning || !grouped.ready.length} onClick={() => void publishItems(grouped.ready)}>
              {processing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              Publish All Ready ({grouped.ready.length})
            </button>
            <button
              type="button"
              className="adm-btn-ghost"
              disabled={processing || scanning || !grouped.needs_review.length}
              onClick={() => void publishItems(grouped.needs_review)}
              title="Publish after reviewing warnings such as an existing image or zero stock"
            >
              <Upload size={14} /> Publish Reviewed ({grouped.needs_review.length})
            </button>
            <button
              type="button"
              className="adm-btn-ghost"
              disabled={processing || scanning || !items.some((i) => !isDraftRowFinished(i) && i.file && i.code && !i.parseError)}
              onClick={() => void archiveItems(items.filter((i) => i.status !== 'done' && i.status !== 'archived'))}
            >
              <Archive size={14} /> Send All to Archive (incl. not found)
            </button>
            <button type="button" className="adm-btn-ghost" disabled={processing || !items.some((i) => i.status === 'error')} onClick={() => void retryFailed()}>
              <RefreshCw size={14} /> Retry Failed
            </button>
            <button type="button" className="adm-btn-ghost" onClick={exportReport}>
              <Download size={14} /> Export Report
            </button>
          </div>
        </>
      )}
    </div>
  );
}
