import { readApiJson } from './apiError.js';
import { catalogueDisplayTitle, catalogueDescription } from './productLoaderDisplay.js';
import { parseIntakeFilename, siblingSkuForCopy } from './parseIntakeFilename';
import { compressImage } from './products';

// Vercel rejects a request before the function runs when the JSON body grows
// beyond its platform limit. Base64 adds roughly one third to the source file,
// so keep landed-shipment images comfortably below that boundary. Small files
// retain their original bytes; larger camera images retain the legacy 800px
// white-canvas JPEG preparation for this bulk-intake path.
export const INSTORE_INLINE_IMAGE_MAX_BYTES = 1_500_000;

function jpegUploadFilename(filename) {
  const name = String(filename || 'product').trim() || 'product';
  return `${name.replace(/\.[^.]+$/, '')}.jpg`;
}

export async function prepareLocalShipmentImage(file, { compress = compressImage } = {}) {
  const size = Number(file?.size);
  if (!file || !Number.isFinite(size) || size < 1) throw new Error('The selected product image is empty');
  if (size <= INSTORE_INLINE_IMAGE_MAX_BYTES) {
    return {
      file,
      filename: String(file.name || 'product.jpg'),
      contentType: String(file.type || 'image/jpeg'),
      compressed: false,
    };
  }

  const prepared = await compress(file);
  const preparedSize = Number(prepared?.size);
  if (!prepared || !Number.isFinite(preparedSize) || preparedSize < 1 || preparedSize > INSTORE_INLINE_IMAGE_MAX_BYTES) {
    throw new Error('This image is too large to send safely. Resize it below 1.5 MB and try again.');
  }
  return {
    file: prepared,
    filename: jpegUploadFilename(file.name),
    contentType: 'image/jpeg',
    compressed: true,
  };
}

export async function lookupFilenames(filenames, files, { groupColourVariants = true, strictExact = false } = {}) {
  let res;
  try {
    res = await fetch('/api/product-loader-batch-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames, groupColourVariants, strictExact }),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('Live product lookup timed out. Nothing was imported; retry the lookup or use a smaller folder.');
    }
    throw error;
  }
  const json = await readApiJson(res, { fallback: 'Lookup failed' });
  const fileByName = new Map(files.map((f) => [f.name, f]));
  return (json.items || []).map((item) => {
    const file = fileByName.get(item.filename) || null;
    const group = item.group || (item.canPublish ? 'ready' : 'not_found');
    // Same-code duplicates ("CODE (2).jpg") each become a sibling product
    // record so no image overwrites another.
    const copyIndex = parseIntakeFilename(item.filename || '').copyIndex || 1;
    return {
      ...item,
      file,
      group,
      copyIndex,
      publishSku: strictExact || item.isColourVariant
        ? item.code
        : siblingSkuForCopy(item.code, copyIndex),
      status: group === 'not_found'
        ? 'unmatched'
        : (group === 'needs_review' ? 'review' : 'ready'),
      processError: item.parseError || '',
      previewUrl: '',
    };
  });
}

export async function logPublishFailure({ sku, filename, reason }) {
  await fetch('/api/product-loader-publish-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku, filename, outcome: 'failed', reason }),
  }).catch(() => {});
}

export async function fetchPublishHistory({ sku = '', q = '', action = '', limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (sku) params.set('sku', sku);
  if (q) params.set('q', q);
  if (action) params.set('action', action);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const res = await fetch(`/api/product-loader-publish-history?${params}`);
  const json = await readApiJson(res, { fallback: 'Failed to load history' });
  return json;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Only a positive acknowledgement for this exact requested SKU is a completed
 * import. A successful HTTP response alone may be an empty/proxy response.
 * Duplicates are explicit skips, never manufactured additions.
 */
export function parseLocalShipmentInstoreResult(json, expectedSku) {
  const sku = String(expectedSku || '').trim().toUpperCase();
  if (!sku || !Array.isArray(json?.results) || json.results.length !== 1) {
    throw new Error('Instore did not confirm an outcome for this item. Refresh its status before retrying.');
  }
  const result = json.results[0];
  if (!result || String(result.sku || '').trim().toUpperCase() !== sku) {
    throw new Error('Instore returned a different SKU. No addition has been confirmed for this item.');
  }
  if (result.ok !== true) throw new Error(result.error || 'Could not add item to Instore');
  if (result.action === 'instore_import' && result.skipped !== true) {
    return { ...result, sku, outcome: 'added' };
  }
  if (result.action === 'instore_skipped' && result.skipped === true
    && ['already_on_main_site', 'already_in_instore'].includes(result.reason)) {
    return { ...result, sku, outcome: 'skipped' };
  }
  throw new Error('Instore did not confirm the requested import. Refresh its status before retrying.');
}

/**
 * Add one exact Positill match from a locally selected landed-shipment folder
 * to Instore only. The server rechecks the SKU, price and description before
 * it accepts the image or confirmed received-piece quantity.
 */
export async function importLocalShipmentToInstore(item, { category, categoryPath, receiptLines, stockMode = 'received' }) {
  if (!item?.file || !item?.code) throw new Error('Missing local image or exact Positill code');
  const preparedImage = await prepareLocalShipmentImage(item.file);
  const imageBase64 = await fileToBase64(preparedImage.file);
  const res = await fetch('/api/nutstore-process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: stockMode === 'positill_live' ? 'instore_live' : 'instore',
      ...(stockMode === 'received' ? { receiptLines } : {}),
      items: [{
        code: item.code,
        filename: preparedImage.filename || item.filename,
        path: item.sourcePath || item.file.webkitRelativePath || item.filename,
        contentType: preparedImage.contentType,
        imageBase64,
        category,
        categoryPath,
        ...(stockMode === 'received' ? { receiptLines } : {}),
        // A department invoice is a Positill export. It may supply the
        // canonical selling unit only when the live STMAST bridge is pending
        // its update. Supplier-invoice PCS values are never used as units;
        // explicit admin confirmations are independently validated on the
        // server and are never represented as Positill-sourced units.
        verifiedSellingUnit: item.sellingUnitSource === 'positill_department_invoice' ? item.unitsOfIssue : '',
        verifiedSellingUnitSource: item.sellingUnitSource === 'positill_department_invoice' ? 'positill_department_invoice' : '',
        adminConfirmedSellingUnit: String(item.sellingUnitSource || '').startsWith('admin_confirmed_') ? 'EACH' : '',
        adminConfirmedSellingUnitSource: ['admin_confirmed_gift_bag_each', 'admin_confirmed_batch_each'].includes(item.sellingUnitSource) ? item.sellingUnitSource : '',
      }],
    }),
  });
  const json = await readApiJson(res, { fallback: 'Could not add item to Instore' });
  return parseLocalShipmentInstoreResult(json, item.code);
}

/** Correct the approved received-stock override for an existing landed item.
 * The server only permits records previously created by this landed-folder
 * workflow; it never creates products or changes images, price or category. */
export async function correctLocalShipmentInstoreQuantity(item, { receiptLines }) {
  if (!item?.code) throw new Error('Missing exact Positill code');
  const res = await fetch('/api/nutstore-process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'instore_correct_received',
      items: [{ code: item.code, receiptLines }],
    }),
  });
  const json = await readApiJson(res, { fallback: 'Could not correct the received quantity' });
  const result = json?.results?.[0];
  if (!Array.isArray(json?.results) || json.results.length !== 1 || result?.ok !== true
    || String(result.sku || '').trim().toUpperCase() !== String(item.code).trim().toUpperCase()
    || result.action !== 'received_quantity_corrected') {
    throw new Error(result?.error || 'Instore did not confirm the requested quantity correction. Refresh its status before retrying.');
  }
  return result;
}

/** Replaces approved landed-stock overrides after Positill exposes the GRV stock. */
export async function reconcileInstoreLandedStock() {
  const res = await fetch('/api/nutstore-process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'instore_reconcile' }),
  });
  return readApiJson(res, { fallback: 'Could not reconcile landed Instore stock with Positill.' });
}

/** Upload one image file to a product's slot (1-4). Returns { url }. */
export async function uploadProductImageSlot({ file, sku, slot, requireNew = false }) {
  if (!file) throw new Error('No file');
  if (!sku) throw new Error('Enter the product code first');
  const b64 = await fileToBase64(file);
  const res = await fetch('/api/upload-product-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'image/jpeg',
      base64: b64,
      sku: String(sku).trim().toUpperCase(),
      imageSlot: Math.min(4, Math.max(1, Number(slot) || 1)),
      requireNew,
    }),
  });
  return readApiJson(res, { fallback: 'Upload failed' });
}

/**
 * Author a brand-new product (no ERP/catalogue match required) with up to four
 * image slots and its metadata in one publish. `images` is [{ slot, url }].
 * `categoryPathIds` is the contiguous taxonomy id array from CategoryPathSelect.
 */
export async function publishNewProduct({
  code, title, price, barcode, description, stockQty, availableStock,
  unitsOfIssue = 'EACH', packDescription = '',
  images = [], categoryPathIds = [], taxonomyTree = [], publishedBy = '',
}) {
  const sku = String(code || '').trim().toUpperCase();
  if (!sku) throw new Error('Product code is required');
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('Title is required');
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) throw new Error('Enter a price greater than 0');

  const labels = pathLabelsFromIds(taxonomyTree, categoryPathIds);
  if (!labels.length) throw new Error('Pick a category');

  const cleanImages = (images || [])
    .filter((i) => i?.url)
    .map((i) => ({ slot: Number(i.slot), url: i.url, source: 'upload' }));
  if (!cleanImages.some((i) => i.slot === 1)) throw new Error('Upload the main image (slot 1)');

  const res = await fetch('/api/product-loader-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: sku,
      title: cleanTitle,
      price: numericPrice,
      barcode: String(barcode || '').trim() || sku,
      description: String(description || '').trim(),
      unitsOfIssue,
      packDescription: String(packDescription || '').trim(),
      images: cleanImages,
      imageUrl: cleanImages.find((i) => i.slot === 1)?.url || cleanImages[0].url,
      imageSlot: 1,
      imageSource: 'upload',
      category: labels[0],
      categoryPath: labels,
      subcategoryOne: labels[1] || labels[0],
      ...(stockQty != null && stockQty !== '' ? { stockQty: Number(stockQty) } : {}),
      ...(availableStock != null && availableStock !== '' ? { availableStock: Number(availableStock) } : {}),
      requireNew: true,
      publishMode: 'direct',
      publishedBy,
    }),
  });
  const json = await readApiJson(res, { fallback: 'Publish failed' });
  return { sku, action: json.action || 'create' };
}

/** Stage an Excel/local-image variant in Product Manager → Archive. */
export async function archiveVariantProduct({
  code, barcode, title, description, price, stockQty, availableStock,
  unitsOfIssue = 'EACH', images = [], publishedBy = '', batchId = '',
  includeExistingInBatch = false,
}) {
  const res = await fetch('/api/product-loader-variant-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      barcode,
      title,
      description,
      price,
      stockQty,
      availableStock,
      unitsOfIssue,
      images,
      publishedBy,
      batchId,
      includeExistingInBatch,
    }),
  });
  return readApiJson(res, { fallback: 'Could not send product to Archive' });
}

async function uploadLoaderImage(item) {
  const b64 = await fileToBase64(item.file);
  const uploadRes = await fetch('/api/upload-product-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: item.filename,
      contentType: item.file.type || 'image/jpeg',
      base64: b64,
      // Duplicates upload under their sibling SKU so each keeps its own object.
      sku: item.publishSku || item.code,
      imageSlot: item.imageSlot,
    }),
  });
  return readApiJson(uploadRes, { fallback: 'Upload failed' });
}

/**
 * Send a locally uploaded loader image to the archive — works even when the
 * code has no Positill/website match yet (placeholder row, tagged nutstore).
 */
export async function archiveLoaderImageItem(item) {
  if (!item?.file || !item.code) throw new Error('Missing image or product code');
  const uploadJson = await uploadLoaderImage(item);
  const res = await fetch('/api/product-loader-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: item.code,
      displayCode: item.displayCode,
      title: item.descriptionOverride || catalogueDisplayTitle(item),
      description: item.descriptionOverride || catalogueDescription(item),
      price: item.price ?? item.sqlRow?.price ?? 0,
      barcode: item.barcode || item.websiteRow?.barcode || item.code,
      imageUrl: uploadJson.url,
      imageSlot: item.imageSlot,
      category: item.websiteRow?.category || '',
      subcategoryOne: item.websiteRow?.subcategory_one || '',
      sqlRow: item.sqlRow || null,
      websiteRow: item.websiteRow || null,
      filename: item.filename,
      unitsOfIssue: item.unitsOfIssue || 'EACH',
      packDescription: item.packDescription || '',
    }),
  });
  await readApiJson(res, { fallback: 'Archive failed' });
  return { sku: item.code, action: 'archived' };
}

// Resolve a contiguous array of taxonomy node ids to their labels, walking the
// tree so the result is a full [category, sub1, sub2, ...] path.
function pathLabelsFromIds(tree, ids = []) {
  const labels = [];
  let nodes = tree || [];
  for (const id of (ids || []).filter(Boolean)) {
    const node = nodes.find((n) => n.id === id);
    if (!node) break;
    labels.push(node.label);
    nodes = node.children || [];
  }
  return labels;
}

function resolveLoaderCategory(item, {
  taxonomyTree,
  findNode,
  defaultCategoryId,
  defaultSub1Id,
  defaultCategoryPathIds,
}) {
  const pathIds = (defaultCategoryPathIds || []).filter(Boolean);
  const defCatId = defaultCategoryId || pathIds[0] || '';
  const defSub1Id = defaultSub1Id || pathIds[1] || '';
  const needsCategory = !item.websiteRow?.category;

  if (needsCategory && !defCatId) {
    throw new Error('Pick a default category for products not already on the website.');
  }

  const catId = item.websiteRow?.category
    ? (taxonomyTree.find((c) => c.label === item.websiteRow.category)?.id || defCatId)
    : defCatId;
  const sub1IdForItem = item.websiteRow?.subcategory_one
    ? ((findNode(taxonomyTree, catId)?.children || [])
      .find((c) => c.label === item.websiteRow.subcategory_one)?.id || defSub1Id)
    : defSub1Id;

  const catNode = findNode(taxonomyTree, catId);
  const sub1Node = findNode(taxonomyTree, sub1IdForItem);
  const defaultPathLabels = pathLabelsFromIds(taxonomyTree, pathIds);
  const categoryLabel = catNode?.label || item.websiteRow?.category || defaultPathLabels[0] || '';
  const sub1Label = sub1Node?.label || item.websiteRow?.subcategory_one || categoryLabel;
  if (!categoryLabel) throw new Error('No category available');

  return {
    categoryLabel,
    sub1Label,
    categoryPath: needsCategory && defaultPathLabels.length ? defaultPathLabels : undefined,
  };
}

/**
 * Publish all images for one recognised colour as one atomic website variant.
 * Positill remains the base code/barcode; the website SKU keeps the colour
 * suffix so the storefront and order line retain the customer's selection.
 */
export async function publishLoaderColourVariant(rows, options) {
  const items = (rows || [])
    .filter((item) => item?.file && item?.isColourVariant && item?.code)
    .sort((a, b) => Number(a.imageSlot || 1) - Number(b.imageSlot || 1));
  if (!items.length) throw new Error('No colour variant images to publish');

  const item = items[0];
  const { categoryLabel, sub1Label, categoryPath } = resolveLoaderCategory(item, options);
  const images = [];
  for (const row of items) {
    const uploaded = await uploadLoaderImage(row);
    images.push({ slot: row.imageSlot, url: uploaded.url, source: 'upload' });
  }

  const publishRes = await fetch('/api/product-loader-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: item.code,
      barcode: item.positillCode || item.barcode || item.variantOf,
      displayCode: item.displayCode,
      title: item.descriptionOverride || catalogueDisplayTitle(item),
      price: item.price ?? item.sqlRow?.price ?? 0,
      images,
      imageUrl: images.find((image) => Number(image.slot) === 1)?.url || images[0]?.url,
      imageSlot: images.find((image) => Number(image.slot) === 1)?.slot || images[0]?.slot || 1,
      imageSource: 'upload',
      overwriteImage: options.overwrite || items.some((row) => row.warnings?.includes('image_exists')),
      category: categoryLabel,
      categoryPath,
      subcategoryOne: sub1Label,
      subcategoryTwo: item.websiteRow?.subcategory_two || null,
      description: item.descriptionOverride || catalogueDescription(item),
      sqlRow: item.sqlRow || null,
      websiteRow: item.variantWebsiteRow || null,
      stockQty: item.sqlRow?.onhand ?? item.websiteRow?.stock_qty,
      availableStock: item.sqlRow?.available ?? item.websiteRow?.available_stock,
      categoryConfidence: item.websiteRow ? 1 : 0.5,
      publishMode: 'colour_variant',
      filename: items.map((row) => row.filename).join(', '),
      unitsOfIssue: item.unitsOfIssue || 'EACH',
      packDescription: item.packDescription || '',
    }),
  });
  const json = await readApiJson(publishRes, { fallback: 'Colour variant publish failed' });
  return { sku: item.code, action: json.action || 'published', imageCount: images.length };
}

/**
 * Attach published colour SKUs to the storefront's product-group overlay.
 * The server discovers colours from earlier uploads through the shared
 * Positill barcode, so a later folder drop can extend the existing card.
 */
export async function syncLoaderColourVariantGroup(rows) {
  const members = [];
  const seen = new Set();
  for (const row of rows || []) {
    const sku = String(row?.code || '').trim().toUpperCase();
    if (!row?.isColourVariant || !sku || seen.has(sku)) continue;
    seen.add(sku);
    members.push({
      sku,
      variantLabel: row.variantLabel || null,
      sortOrder: members.length,
    });
  }
  if (!members.length) return { grouped: false, reason: 'no_variants' };

  const first = (rows || []).find((row) => row?.isColourVariant && row?.positillCode);
  const res = await fetch('/api/product-loader-colour-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseCode: first?.positillCode,
      title: catalogueDisplayTitle(first),
      primaryWebsiteSku: members[0].sku,
      members,
    }),
  });
  return readApiJson(res, { fallback: 'Colour variants were published but could not be grouped' });
}

export async function publishLoaderImageItem(item, {
  taxonomyTree,
  findNode,
  defaultCategoryId,
  defaultSub1Id,
  defaultCategoryPathIds,
  overwrite,
  filename,
}) {
  if (!item?.file || !item.code) throw new Error('Missing image or product code');

  const { categoryLabel, sub1Label, categoryPath } = resolveLoaderCategory(item, {
    taxonomyTree,
    findNode,
    defaultCategoryId,
    defaultSub1Id,
    defaultCategoryPathIds,
  });

  const uploadJson = await uploadLoaderImage(item);

  const publishRes = await fetch('/api/product-loader-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Copy #2+ publishes to a sibling SKU (CODE-2…) sharing the base
      // barcode, so each same-code image is its own product record.
      code: item.publishSku || item.code,
      barcode: item.barcode || item.websiteRow?.barcode || item.code,
      displayCode: item.displayCode,
      title: item.descriptionOverride || catalogueDisplayTitle(item),
      price: item.price ?? item.sqlRow?.price ?? 0,
      imageUrl: uploadJson.url,
      imageSlot: item.imageSlot,
      imageSource: 'upload',
      overwriteImage: overwrite || item.warnings?.includes('image_exists'),
      category: categoryLabel,
      categoryPath,
      subcategoryOne: sub1Label,
      subcategoryTwo: item.websiteRow?.subcategory_two || null,
      description: item.descriptionOverride || catalogueDescription(item),
      sqlRow: item.sqlRow || null,
      websiteRow: item.websiteRow || null,
      stockQty: item.sqlRow?.onhand ?? item.websiteRow?.stock_qty,
      availableStock: item.sqlRow?.available ?? item.websiteRow?.available_stock,
      categoryConfidence: item.websiteRow ? 1 : 0.5,
      publishMode: 'direct',
      filename: filename || item.filename,
      unitsOfIssue: item.unitsOfIssue || 'EACH',
      packDescription: item.packDescription || '',
    }),
  });
  await readApiJson(publishRes, { fallback: 'Publish failed' });
  return { sku: item.publishSku || item.code, action: publishRes.ok ? 'published' : 'failed' };
}
