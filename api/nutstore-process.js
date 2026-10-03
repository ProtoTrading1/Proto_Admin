import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normalizeInstoreCopy } from '../lib/instore-copy.mjs';
import { recordInstoreCopyIntent } from './_instore-copy.js';
import { catalogueDescription, catalogueDisplayTitle } from '../lib/product-loader-display.mjs';
import { requireOwner, verifyAdminUser } from './_admin-auth.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';
import { downloadNutstoreFile, isNutstoreConfigured, nutstoreSetupMessage } from './_nutstore-webdav.js';
import { inferExplicitPiecePackFromDescription, normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';
import { receivedInvoiceLinesToSellable } from '../lib/received-stock-unit.mjs';
import { verifiedLiveInstoreStock } from '../lib/instore-live-stock.mjs';
import { isAdminConfirmedGiftBagEach } from '../lib/admin-confirmed-gift-bag-unit.mjs';
import { isAdminConfirmedBatchEach } from '../lib/admin-confirmed-batch-unit.mjs';
import { instoreCategoryAssignmentBlocker } from '../lib/instore-category-assignment.mjs';
import { customerPriceFromPositill } from '../lib/catalogue-price.mjs';
import { fetchStmastRow, sqlRowToPreview } from './_sql-stmast.js';
import { getStockClient } from './_stock-client.js';
import { parseLoaderFilename } from './_product-loader-filename.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const BUCKET = 'product-images';
/** Catalogue archive tag — shows in Product Manager → Archived (not dormant queue). */
export const NUTSTORE_ARCHIVED_BY = 'nutstore';
const ARCHIVE_DEFAULT_CATEGORY = 'Uncategorised';
const ARCHIVE_DEFAULT_SUB = 'General';
const SLOT_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
// The landed importer must prove every column it will write before the UI
// enables its action. Checking just `sku` makes a legacy schema look healthy,
// then fails only after an image has been uploaded. Keep audit/reconciliation
// metadata intact and fail closed with a useful preflight result instead.
const INSTORE_WRITE_COLUMNS = [
  'sku', 'supplier_name', 'barcode', 'title', 'original_description', 'price',
  'available_stock', 'minimum_stock', 'category', 'image_url', 'image_source',
  'image_source_key', 'image_review_status', 'visibility_status', 'is_active',
  'source_observed_at', 'image_observed_at', 'last_synced_at', 'updated_at',
].join(',');

// The endpoint exists in every environment but must stay inert until an owner
// deliberately enables it on the production deployment. Previews and local
// builds must never write Instore records merely by inheriting stock credentials.
function instoreLandedImportEnabled() {
  // This variable is scoped to Vercel Production only. Do not use VERCEL_ENV
  // here: this project has a configured value with that name, which can shadow
  // Vercel's automatic environment indicator and incorrectly lock live Admin.
  return process.env.INSTORE_LANDED_IMPORT_MODE === 'production-enabled';
}

function resolveArchiveCategories(item) {
  const category = String(
    item.category || item.websiteRow?.category || item.sqlRow?.dept || ARCHIVE_DEFAULT_CATEGORY,
  ).trim() || ARCHIVE_DEFAULT_CATEGORY;
  const subcategoryOne = String(
    item.subcategoryOne || item.subcategory_one || item.websiteRow?.subcategory_one || category,
  ).trim() || ARCHIVE_DEFAULT_SUB;
  return { category, subcategoryOne };
}

// Preserve the existing Nutstore publish/archive connection contract. Only
// the recovered local Instore workflow uses the shared server stock client.
function getLegacyNutstoreClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function uploadImageBuffer(sb, { sku, slot, filename, buffer, contentType }) {
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  const ext = String(filename).split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const objectPath = `${sku}/${slot}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(objectPath, buffer, {
    contentType: contentType || 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;
  const { data: { publicUrl } } = sb.storage.from(BUCKET).getPublicUrl(objectPath);
  return publicUrl;
}

function validInstoreSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku) ? sku : '';
}

// Older live product mirrors do not always include optional presentation
// columns. `units_of_issue` itself is not optional for landed stock: without a
// verified canonical unit there is no safe way to turn received pieces into
// customer-sellable stock.
async function fetchCanonicalUnitMeta(sb, sku) {
  const { data: base, error: baseError } = await sb
    .from('products')
    // `units_of_issue` is required canonical product metadata and is present
    // in the live backend. Keep it separate from optional presentation fields
    // so a legacy-column mismatch can never hide the Positill unit.
    .select('sku,units_of_issue')
    .eq('sku', sku)
    .maybeSingle();
  if (baseError) throw baseError;
  if (!base) return null;

  const { data: metadata, error: metadataError } = await sb
    .from('products')
    .select('pack_description')
    .eq('sku', sku)
    .maybeSingle();
  if (metadataError) return base;
  return { ...base, ...metadata };
}

function positiveWhole(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1000000 ? parsed : null;
}

function decodeLocalImage(item, sku) {
  const encoded = String(item.imageBase64 || '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('A valid local shipment image is required');
  }
  const buffer = Buffer.from(encoded, 'base64');
  // Keep raw data below the 4 MB route payload limit once base64 overhead and
  // the remaining request fields are included.
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
    throw new Error('Local image must be between 1 byte and 2 MB');
  }
  const contentType = String(item.contentType || 'image/jpeg').trim() || 'image/jpeg';
  if (!/^image\/[a-z0-9.+-]+$/i.test(contentType)) {
    throw new Error('Local shipment file must be an image');
  }
  return {
    buffer,
    filename: String(item.filename || '').trim() || `${sku}.jpg`,
    contentType,
  };
}

function instoreImageObjectPath(sku, filename) {
  const ext = String(filename).split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  // A unique key avoids overwriting an image belonging to a concurrent import.
  return `instore/${sku}/${randomUUID()}.${ext}`;
}

async function uploadInstoreImage(sb, { sku, filename, buffer, contentType }) {
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
  const objectPath = instoreImageObjectPath(sku, filename);
  const { error } = await sb.storage.from(BUCKET).upload(objectPath, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw error;
  const { data: { publicUrl } } = sb.storage.from(BUCKET).getPublicUrl(objectPath);
  return { objectPath, imageUrl: publicUrl };
}

async function importInstoreOne(sb, item, { receiptLines, actor, stockMode = 'received' }) {
  const sku = validInstoreSku(item.code);
  if (stockMode === 'positill_live' && parseLoaderFilename(item.filename).code !== sku) {
    throw new Error(`${sku || 'This item'}: the image filename must match its exact Positill SKU.`);
  }
  const category = String(item.category || '').trim();
  const categoryPath = Array.isArray(item?.categoryPath)
    ? item.categoryPath.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!sku || !category || category.length > 120 || !categoryPath.length) {
    throw new Error('A valid exact SKU and explicit Instore destination are required');
  }

  // Browser lookup results and cache entries are advisory. The live bridge is
  // re-read immediately before the write and must return this exact Positill
  // code with a usable title and price.
  const raw = await fetchStmastRow(sku);
  if (!raw || String(raw.CODE || raw.code || '').trim().toUpperCase() !== sku) {
    throw new Error(`${sku} was not found as an exact live Positill code`);
  }
  const source = sqlRowToPreview(raw);
  const sourceItem = { code: sku, sqlRow: source };
  // Positill supplies the default copy and every stock/category/unit check.
  // Optional reviewed website wording is separate: it cannot influence the
  // source checks or change Positill and is normalised only for the listing.
  const title = catalogueDisplayTitle(sourceItem).toUpperCase();
  const description = catalogueDescription(sourceItem).toUpperCase();
  const websiteCopy = item.websiteCopy === undefined ? { title, description } : normalizeInstoreCopy(item.websiteCopy);
  // Positill STMAST PRICE_A is ex VAT. Persist the same VAT-inclusive,
  // rounded customer price that Product Loader displays for this live row.
  const price = customerPriceFromPositill(source?.price);
  if (!title || !description || !Number.isFinite(price) || price <= 0) {
    throw new Error(`${sku} is missing a usable live Positill description or price`);
  }
  const categoryBlocker = instoreCategoryAssignmentBlocker({
    category,
    categoryPath,
    description,
  });
  if (categoryBlocker) throw new Error(`${sku}: ${categoryBlocker}`);

  // Block before storage upload: an existing main-site SKU keeps its canonical
  // description and image rather than gaining a separate Instore record.
  const [existingWebsiteBySku, existingWebsiteByBarcode] = await Promise.all([
    sb.from('website_stock').select('sku').eq('sku', sku).maybeSingle(),
    sb.from('website_stock').select('sku').eq('barcode', sku).limit(1).maybeSingle(),
  ]);
  if (existingWebsiteBySku.error) throw existingWebsiteBySku.error;
  if (existingWebsiteByBarcode.error) throw existingWebsiteByBarcode.error;
  if (existingWebsiteBySku.data || existingWebsiteByBarcode.data) {
    return {
      sku, action: 'instore_skipped', skipped: true, reason: 'already_on_main_site',
      message: `${sku} is already on the main website by SKU or barcode; it was not added to Instore.`,
    };
  }

  // Keep the existing Instore guard server-side as well as in the review UI.
  const { data: existingInstore, error: existingInstoreError } = await sb
    .from('extended_range_items').select('sku').eq('sku', sku).maybeSingle();
  if (existingInstoreError) throw existingInstoreError;
  if (existingInstore) {
    return {
      sku, action: 'instore_skipped', skipped: true, reason: 'already_in_instore',
      message: `${sku} is already in Instore; edit it there instead. Its existing image and details were preserved.`,
    };
  }
  // Positill's live unit is authoritative. The product mirror and an explicit
  // piece count in the Positill description are conservative fallbacks while
  // the read-only bridge is being upgraded. Never default an unknown SKU to
  // EACH: a pack would otherwise be published with inflated availability.
  const positillUnits = String(source?.units_of_issue || '').trim();
  const liveStock = stockMode === 'positill_live' ? verifiedLiveInstoreStock(raw, sku) : null;
  if (liveStock?.blocker) throw new Error(`${sku}: ${liveStock.blocker}`);
  // Do not make a landed import depend on the optional product mirror when
  // the exact live Positill response already supplies the authoritative unit.
  // This was the hidden failure mode behind a disabled import button on older
  // Admin databases: the mirror schema check failed even though Positill had
  // a valid unit and the Instore destination was healthy.
  const canonicalProduct = (positillUnits || liveStock) ? null : await fetchCanonicalUnitMeta(sb, sku);
  const mirroredUnits = String(canonicalProduct?.units_of_issue || '').trim();
  const explicitDescriptionUnit = inferExplicitPiecePackFromDescription(source?.title || description);
  // A Positill department invoice is the companion export supplied with a
  // landed shipment. It is allowed only as a narrow fallback while STMAST has
  // not yet exposed the unit; a supplier invoice's PCS column never reaches
  // this field.
  const departmentInvoiceUnit = String(item?.verifiedSellingUnitSource === 'positill_department_invoice'
    ? item?.verifiedSellingUnit || ''
    : '').trim();
  const adminConfirmedGiftBagUnit = !positillUnits && !mirroredUnits && !explicitDescriptionUnit && !departmentInvoiceUnit
    && item?.adminConfirmedSellingUnitSource === 'admin_confirmed_gift_bag_each'
    && String(item?.adminConfirmedSellingUnit || '').trim().toUpperCase() === 'EACH'
    && String(category).trim().toLowerCase() === 'packaging & storage'
    && isAdminConfirmedGiftBagEach({
      sku,
      description,
      categoryPath,
      receiptLines,
    })
    ? 'EACH'
    : '';
  const adminConfirmedBatchUnit = !positillUnits && !mirroredUnits && !explicitDescriptionUnit && !departmentInvoiceUnit && !adminConfirmedGiftBagUnit
    && item?.adminConfirmedSellingUnitSource === 'admin_confirmed_batch_each'
    && String(item?.adminConfirmedSellingUnit || '').trim().toUpperCase() === 'EACH'
    && isAdminConfirmedBatchEach({ sku, categoryPath, receiptLines })
    ? 'EACH'
    : '';
  const rawUnitsOfIssue = positillUnits || mirroredUnits || explicitDescriptionUnit || departmentInvoiceUnit || adminConfirmedGiftBagUnit || adminConfirmedBatchUnit;
  const receipt = liveStock ? null : receivedInvoiceLinesToSellable(receiptLines, rawUnitsOfIssue);
  if (receipt && !rawUnitsOfIssue && receipt.receivedPieces) {
    throw new Error(`${sku} has no verified canonical selling unit; resolve its Positill unit before importing received stock`);
  }
  const unitsSource = liveStock ? 'positill_live' : positillUnits
    ? 'positill_live'
    : mirroredUnits
      ? 'positill_product'
      : explicitDescriptionUnit
        ? 'positill_description_explicit'
        : departmentInvoiceUnit
          ? 'positill_department_invoice'
          : adminConfirmedGiftBagUnit
            ? 'admin_confirmed_gift_bag_each'
            : adminConfirmedBatchUnit
              ? 'admin_confirmed_batch_each'
              : rawUnitsOfIssue ? 'positill_department_invoice' : 'supplier_receipt_pks';
  const unitsOfIssue = liveStock?.unitsOfIssue || (rawUnitsOfIssue ? normalizeUnitsOfIssue(rawUnitsOfIssue) : 'PACK');
  const sellableQty = liveStock?.sellableQty ?? receipt?.sellableQty ?? 0;
  const packDescription = String(canonicalProduct?.pack_description || '').trim();
  if (sellableQty < 1) {
    throw new Error(`${sku} has no whole sellable ${unitsOfIssue} in ${liveStock ? 'live Positill stock' : 'the received invoice'}`);
  }

  const { buffer, filename, contentType } = decodeLocalImage(item, sku);
  if (item.websiteCopy !== undefined) await recordInstoreCopyIntent(sb, { sku, actor, oldValues: { positillTitle: title, positillDescription: description }, copy: websiteCopy });
  const { objectPath, imageUrl } = await uploadInstoreImage(sb, {
    sku, filename, buffer, contentType,
  });
  const now = new Date().toISOString();
  const sourceKey = `${liveStock ? 'local-folder-live' : 'local-folder'}:${String(item.path || filename).trim() || filename}`;
  try {
    // `units_of_issue` and `pack_description` are descriptive metadata only.
    // The live Instore table predates both columns in some environments.
    // Positill's unit is still used above to calculate the sellable quantity;
    // never block a valid received-stock import on optional display metadata.
    const instoreInsert = {
      sku,
      supplier_name: 'POSITILL',
      barcode: sku,
      title: websiteCopy.title,
      original_description: websiteCopy.description,
      price,
      // PKS receipt lines are already sellable packs. PCS receipt lines are
      // converted through the canonical Positill unit while the GRV is pending.
      available_stock: sellableQty,
      minimum_stock: 1,
      category,
      image_url: imageUrl,
      // The live Instore schema currently permits only the established
      // `nutstore` source value. The landed-shipment provenance is retained
      // separately in `supplier_name` and `image_source_key`, so this does
      // not make the item publish to the main website.
      image_source: 'nutstore',
      image_source_key: sourceKey,
      image_review_status: 'verified',
      visibility_status: 'search_only',
      is_active: true,
      source_observed_at: now,
      image_observed_at: now,
      last_synced_at: now,
      updated_at: now,
    };
    const { error } = await sb.from('extended_range_items').insert(instoreInsert);
    if (error) throw error;
  } catch (error) {
    // Storage is not transactional with Postgres. Remove precisely the new,
    // unique object if its database row did not insert.
    await sb.storage.from(BUCKET).remove([objectPath]).catch(() => {});
    // A second importer may win the exact-SKU insert after our preflight.
    // Only classify a unique violation as a skip after verifying that this
    // exact Instore SKU now exists; every other failure stays a failure.
    if (String(error?.code || '') === '23505') {
      const concurrent = await sb.from('extended_range_items').select('sku').eq('sku', sku).maybeSingle();
      if (!concurrent.error && concurrent.data?.sku === sku) {
        return {
          sku, action: 'instore_skipped', skipped: true, reason: 'already_in_instore',
          message: `${sku} was added by another import; its existing image and details were preserved.`,
        };
      }
    }
    throw error;
  }

  let auditWarning = null;
  try {
    await logProductLoaderAudit(sb, {
      sku,
      action: 'create',
      source: liveStock ? 'local_folder_instore_live_import' : 'local_folder_instore_import',
      publishMode: 'instore_only_available_now',
      imageSlot: 1,
      imageSource: 'local_folder',
      newValues: {
        sourceKey,
        positillTitle: title,
        positillDescription: description,
        websiteTitle: websiteCopy.title,
        websiteDescription: websiteCopy.description,
        category,
        stockMode: liveStock ? 'positill_live' : 'received',
        receivedQty: receipt?.receivedQty ?? null,
        receivedPieces: receipt?.receivedPieces ?? null,
        receivedPacks: receipt?.receivedPacks ?? null,
        receiptLines: receipt?.receiptLines ?? [],
        sellableQty,
        liveOnhand: liveStock?.onhand ?? null,
        liveBooked: liveStock?.booked ?? null,
        unitSize: receipt?.unitSize ?? null,
        remainder: receipt?.remainder ?? null,
        unitsOfIssue,
        unitsSource,
        packDescription,
        positillPriceExVat: Number(source.price) || null,
        customerPriceInclVat: price,
        recordedOnhand: Number.isFinite(Number(source.onhand)) ? Number(source.onhand) : null,
        recordedAvailable: Number.isFinite(Number(source.available)) ? Number(source.available) : null,
        imageUrl,
      },
      publishedBy: actor,
    });
  } catch {
    auditWarning = 'Instore item was added but its audit record could not be written.';
  }
  return {
    sku,
    action: 'instore_import',
    receivedQty: receipt?.receivedQty ?? null,
    sellableQty,
    unitSize: receipt?.unitSize ?? null,
    remainder: receipt?.remainder ?? null,
    recordedOnhand: Number.isFinite(Number(source.onhand)) ? Number(source.onhand) : null,
    recordedAvailable: Number.isFinite(Number(source.available)) ? Number(source.available) : null,
    imageUrl,
    unitsOfIssue,
    unitsSource,
    packDescription,
    auditWarning,
  };
}

async function reconcileInstoreLandedStock(sb, { actor }) {
  const { data: rows, error } = await sb
    .from('extended_range_items')
    .select('sku, available_stock, image_source, image_source_key')
    .eq('image_source', 'nutstore')
    // Only reconcile the landed-shipment records created from Positill.
    // Other local-folder items must never have their availability changed by
    // this GRV catch-up action.
    .eq('supplier_name', 'POSITILL')
    .limit(1000);
  if (error) throw error;

  const results = [];
  for (const row of rows || []) {
    const sku = validInstoreSku(row.sku);
    if (!sku) continue;
    const raw = await fetchStmastRow(sku);
    if (!raw || String(raw.CODE || raw.code || '').trim().toUpperCase() !== sku) {
      results.push({ sku, ok: false, reason: 'exact_live_positill_row_unavailable' });
      continue;
    }
    const live = sqlRowToPreview(raw);
    const available = Number(live?.available);
    // A non-positive Positill value means GRV is still not available to the
    // bridge, so preserve the approved received-stock override.
    if (!Number.isFinite(available) || available < 1) {
      results.push({ sku, ok: true, action: 'preserved_override', available });
      continue;
    }
    if (Number(row.available_stock) === available) {
      results.push({ sku, ok: true, action: 'already_reconciled', available });
      continue;
    }
    const { error: updateError } = await sb
      .from('extended_range_items')
      .update({ available_stock: available, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('sku', sku);
    if (updateError) throw updateError;
    await logProductLoaderAudit(sb, {
      sku,
      action: 'update',
      source: 'instore_grv_reconcile',
      publishMode: 'instore_only_available_now',
      imageSlot: 1,
      imageSource: row.image_source,
      newValues: { previousOverride: row.available_stock, positillAvailable: available, imageSourceKey: row.image_source_key },
      publishedBy: actor,
    }).catch(() => {});
    results.push({ sku, ok: true, action: 'reconciled_to_positill', available });
  }
  return results;
}

// Correct a previously approved landed shipment when its supplier invoice was
// interpreted with the legacy "every quantity is PCS" rule.  This is purpose
// built for the receipt itself: it cannot create products, upload or replace
// images, change price/category/title, or touch the main catalogue.
async function correctInstoreReceivedQuantities(sb, items, { actor }) {
  const results = [];
  for (const item of items) {
    const sku = validInstoreSku(item?.code);
    try {
      if (!sku) throw new Error('A valid exact SKU is required');
      const receiptLines = (item.receiptLines || []).map((line) => ({
        qty: positiveWhole(line?.qty),
        unit: String(line?.unit || '').trim(),
      }));
      if (!receiptLines.length || receiptLines.some((line) => !line.qty)) {
        throw new Error(`${sku} needs at least one positive received invoice quantity`);
      }

      // This is deliberately narrower than the normal Instore importer.  A
      // correction may only update a record that this landed-folder workflow
      // previously created; manually managed and main-site records stay out
      // of scope even if their SKU appears in an uploaded invoice.
      const { data: existing, error: existingError } = await sb
        .from('extended_range_items')
        .select('sku,available_stock,supplier_name,image_source,image_source_key')
        .eq('sku', sku)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing
        || existing.supplier_name !== 'POSITILL'
        || existing.image_source !== 'nutstore'
        || !String(existing.image_source_key || '').startsWith('local-folder:')) {
        throw new Error(`${sku} is not an eligible landed-shipment Instore record`);
      }

      const raw = await fetchStmastRow(sku);
      if (!raw || String(raw.CODE || raw.code || '').trim().toUpperCase() !== sku) {
        throw new Error(`${sku} was not found as an exact live Positill code`);
      }
      const source = sqlRowToPreview(raw);
      const positillUnits = String(source?.units_of_issue || '').trim();
      const canonicalProduct = positillUnits ? null : await fetchCanonicalUnitMeta(sb, sku);
      const rawUnitsOfIssue = positillUnits || String(canonicalProduct?.units_of_issue || '').trim();
      const receipt = receivedInvoiceLinesToSellable(receiptLines, rawUnitsOfIssue);
      if (!rawUnitsOfIssue && receipt.receivedPieces) {
        throw new Error(`${sku} has no verified Positill selling unit for received PCS`);
      }
      if (receipt.sellableQty < 1) {
        throw new Error(`${sku} has no whole sellable units in the received invoice`);
      }

      const now = new Date().toISOString();
      const { error: updateError } = await sb
        .from('extended_range_items')
        .update({ available_stock: receipt.sellableQty, last_synced_at: now, updated_at: now })
        .eq('sku', sku);
      if (updateError) throw updateError;
      await logProductLoaderAudit(sb, {
        sku,
        action: 'update',
        source: 'local_folder_instore_quantity_correction',
        publishMode: 'instore_only_available_now',
        imageSlot: 1,
        imageSource: existing.image_source,
        newValues: {
          previousAvailableStock: existing.available_stock,
          receiptLines: receipt.receiptLines,
          receivedPieces: receipt.receivedPieces,
          receivedPacks: receipt.receivedPacks,
          sellableQty: receipt.sellableQty,
          unitsOfIssue: rawUnitsOfIssue ? normalizeUnitsOfIssue(rawUnitsOfIssue) : 'PACK',
          imageSourceKey: existing.image_source_key,
        },
        publishedBy: actor,
      }).catch(() => {});
      results.push({ sku, ok: true, action: 'received_quantity_corrected', previousAvailableStock: existing.available_stock, availableStock: receipt.sellableQty });
    } catch (error) {
      results.push({ sku: sku || String(item?.code || '').trim().toUpperCase(), ok: false, error: error.message || 'failed' });
    }
  }
  return results;
}

async function publishOne(sb, item, { overwriteImage }) {
  const sku = String(item.code || '').trim().toUpperCase();
  const path = String(item.path || '').trim();
  if (!sku || !path) throw new Error('code and path required');

  const category = String(item.category || '').trim();
  const subcategoryOne = String(item.subcategoryOne || item.subcategory_one || category).trim();
  if (!category || !subcategoryOne) throw new Error('category and subcategoryOne required');

  const slot = 1;
  const imageField = SLOT_FIELDS[slot - 1];
  const { data: existing, error: lookupErr } = await sb
    .from('website_stock')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  const shouldOverwrite = overwriteImage || item.overwriteImage || item.warnings?.includes('image_exists');
  if (existing?.[imageField] && !shouldOverwrite) {
    const err = new Error(`Image slot 1 already has an image for ${sku}`);
    err.code = 'image_exists';
    throw err;
  }

  // A saved browser lookup can be stale. Re-read exact Positill PRICE_A before
  // uploading the image so a failed price check leaves no orphaned asset.
  const price = await legacyNutstoreUploadPrice(item, sku, existing?.price);
  const { buffer, contentType, filename } = await downloadNutstoreFile(path);
  const imageUrl = await uploadImageBuffer(sb, { sku, slot: 1, filename, buffer, contentType });

  const now = new Date().toISOString();
  const { title, description } = resolveCatalogTextFields(item);
  const unitsOfIssue = normalizeUnitsOfIssue(
    item.unitsOfIssue || existing?.units_of_issue || 'EACH',
  );

  const patch = {
    title,
    price,
    units_of_issue: unitsOfIssue,
    pack_description: String(item.packDescription || existing?.pack_description || '').trim(),
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: item.subcategoryTwo || item.subcategory_two || null,
    original_description: description,
    [imageField]: imageUrl,
    updated_at: now,
  };
  if (item.sqlRow?.onhand != null) patch.stock_qty = Number(item.sqlRow.onhand);
  if (item.sqlRow?.available != null) patch.available_stock = Number(item.sqlRow.available);

  let action;
  if (existing) {
    action = 'update';
    const { error } = await sb.from('website_stock').update(patch).eq('sku', sku);
    if (error) throw error;
  } else {
    action = 'create';
    const { error } = await sb.from('website_stock').insert({
      sku,
      barcode: String(item.barcode || sku).trim(),
      ...patch,
      stock_qty: patch.stock_qty ?? 0,
      available_stock: patch.available_stock ?? patch.stock_qty ?? 0,
      image_url_two: null,
      image_url_three: null,
      image_url_four: null,
    });
    if (error) throw error;
  }

  await logProductLoaderAudit(sb, {
    sku,
    action,
    source: 'nutstore_product_loader',
    publishMode: 'direct',
    imageSlot: 1,
    imageSource: 'nutstore',
    oldValues: existing ? { title: existing.title, price: existing.price, [imageField]: existing[imageField] } : null,
    newValues: {
      outcome: 'published',
      title,
      price,
      unitsOfIssue,
      category,
      subcategoryOne,
      imageUrl,
      nutstorePath: path,
      filename: item.filename || filename,
    },
    publishedBy: String(item.publishedBy || '').trim() || null,
  });

  return { sku, action, imageUrl };
}

function resolveCatalogTextFields(item) {
  const hasMatch = Boolean(item.sqlRow || item.websiteRow);
  if (!hasMatch) return { title: '', description: '' };
  return {
    title: catalogueDisplayTitle(item),
    description: catalogueDescription(item),
  };
}

async function legacyNutstoreUploadPrice(item, sku, existingPrice = 0) {
  if (item.sqlRow) {
    const code = String(item.sqlRow.code || item.barcode || sku).trim().toUpperCase();
    const raw = await fetchStmastRow(code);
    if (!raw || String(raw.CODE || raw.code || '').trim().toUpperCase() !== code) {
      throw new Error(`${code}: live Positill price could not be verified`);
    }
    const price = customerPriceFromPositill(sqlRowToPreview(raw).price);
    if (price <= 0) throw new Error(`${code}: live Positill price is invalid`);
    return price;
  }
  // A genuinely unmatched, manually priced image has no Positill ex-VAT
  // amount to convert. Keep its entered inclusive price or existing price.
  return Number(item.price) > 0 ? Number(item.price) : Number(existingPrice) || 0;
}

function buildArchivePayload(item, { sku, imageUrl, filename, now, price }) {
  const { category, subcategoryOne } = resolveArchiveCategories(item);
  const resolved = resolveCatalogTextFields(item);
  // Unmatched codes still archive — placeholder text until a code fix
  // re-links them to Positill (see api/update-product.js re-lookup).
  const title = resolved.title || String(item.displayCode || '').trim() || sku;
  const description = resolved.description || title;
  return {
    sku,
    barcode: sku,
    title,
    original_description: description,
    price,
    units_of_issue: normalizeUnitsOfIssue(item.unitsOfIssue || 'EACH'),
    pack_description: String(item.packDescription || '').trim(),
    category,
    subcategory_one: subcategoryOne,
    subcategory_two: item.subcategoryTwo || item.subcategory_two || null,
    subcategory_three: item.subcategoryThree || item.subcategory_three || null,
    subcategory_four: item.subcategoryFour || item.subcategory_four || null,
    image_url_one: imageUrl,
    archived_by: NUTSTORE_ARCHIVED_BY,
    archived_at: now,
    updated_at: now,
  };
}

async function archiveOne(sb, item) {
  const sku = String(item.code || '').trim().toUpperCase();
  const path = String(item.path || '').trim();
  if (!sku || !path) throw new Error('code and path required');

  const [{ data: liveRow }, { data: archivedRow }] = await Promise.all([
    sb.from('website_stock').select('*').eq('sku', sku).maybeSingle(),
    sb.from('archived_products').select('sku, archived_by, price').eq('sku', sku).maybeSingle(),
  ]);

  if (archivedRow && archivedRow.archived_by !== NUTSTORE_ARCHIVED_BY) {
    throw new Error(`SKU "${sku}" is archived as "${archivedRow.archived_by}"`);
  }

  const price = await legacyNutstoreUploadPrice(item, sku, liveRow?.price || archivedRow?.price);
  const { buffer, contentType, filename } = await downloadNutstoreFile(path);
  const imageUrl = await uploadImageBuffer(sb, { sku, slot: 1, filename, buffer, contentType });
  const now = new Date().toISOString();
  const payload = buildArchivePayload(item, { sku, imageUrl, filename, now, price });
  const title = payload.title;

  let archiveAction = 'create';

  if (liveRow) {
    const shouldOverwrite = item.overwriteImage || item.warnings?.includes('image_exists') || !liveRow.image_url_one;
    const livePatch = {
      title: payload.title,
      price: payload.price,
      category: payload.category,
      subcategory_one: payload.subcategory_one,
      subcategory_two: payload.subcategory_two,
      original_description: payload.original_description,
      updated_at: now,
    };
    if (shouldOverwrite || !liveRow.image_url_one) {
      livePatch.image_url_one = imageUrl;
    }
    if (item.sqlRow?.onhand != null) livePatch.stock_qty = Number(item.sqlRow.onhand);
    if (item.sqlRow?.available != null) livePatch.available_stock = Number(item.sqlRow.available);

    const { error: updateErr } = await sb.from('website_stock').update(livePatch).eq('sku', sku);
    if (updateErr) throw updateErr;

    const { error: rpcErr } = await sb.rpc('archive_product', { p_sku: sku, p_by: NUTSTORE_ARCHIVED_BY });
    if (rpcErr) throw rpcErr;
    archiveAction = 'archive_live';
  } else if (archivedRow) {
    archiveAction = 'update';
    const { error } = await sb.from('archived_products').update(payload).eq('sku', sku);
    if (error) throw error;
  } else {
    const { error } = await sb.from('archived_products').insert(payload);
    if (error) throw error;
  }

  await logProductLoaderAudit(sb, {
    sku,
    action: archiveAction === 'create' ? 'create' : 'update',
    source: 'nutstore_product_loader',
    publishMode: 'archive',
    imageSlot: 1,
    imageSource: 'nutstore',
    newValues: {
      outcome: 'archived',
      archivedBy: NUTSTORE_ARCHIVED_BY,
      title,
      category: payload.category,
      subcategoryOne: payload.subcategory_one,
      imageUrl,
      nutstorePath: path,
      filename: item.filename || filename,
    },
    publishedBy: String(item.publishedBy || '').trim() || null,
  });

  return { sku, imageUrl, archivedBy: NUTSTORE_ARCHIVED_BY };
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    let schemaReady = false;
    let schemaError = '';
    try {
      const stock = getStockClient();
      // `extended_range_items` is the only database table the landed import
      // writes. `products` is merely a fallback source for a missing Positill
      // unit, so a legacy mirror must not disable an otherwise safe import.
      const instore = await stock.from('extended_range_items').select(INSTORE_WRITE_COLUMNS).limit(0);
      schemaReady = !instore.error;
      schemaError = instore.error?.message || '';
    } catch {
      schemaReady = false;
      schemaError = 'The Instore database could not be checked.';
    }
    return res.status(200).json({
      instoreLandedImportEnabled: instoreLandedImportEnabled(),
      schemaReady,
      schemaError: schemaReady ? '' : schemaError,
      environment: process.env.VERCEL_ENV || 'development',
    });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { action, items, overwriteImage = false } = req.body || {};
  if (!['publish', 'archive', 'instore', 'instore_live', 'instore_reconcile', 'instore_correct_received'].includes(action)) {
    return res.status(400).json({ error: 'action must be publish, archive, instore, instore_live, instore_reconcile or instore_correct_received' });
  }
  if (action !== 'instore_reconcile' && (!Array.isArray(items) || !items.length)) {
    return res.status(400).json({ error: 'items[] required' });
  }
  if ((action === 'instore' || action === 'instore_live' || action === 'instore_reconcile' || action === 'instore_correct_received') && !instoreLandedImportEnabled()) {
    return res.status(503).json({ error: 'Landed Instore actions are disabled outside explicitly enabled production.' });
  }
  if ((action === 'instore' || action === 'instore_correct_received') && items.some((item) => !Array.isArray(item?.receiptLines) || !item.receiptLines.length || item.receiptLines.some((line) => !positiveWhole(line?.qty)))) {
    return res.status(400).json({ error: 'Each Instore item needs at least one positive received invoice quantity.' });
  }
  if (action === 'instore_live' && items.some((item) => item?.receiptLines?.length)) {
    return res.status(400).json({ error: 'Already-GRV’d items must use live Positill stock, not a received invoice quantity.' });
  }
  // A landed-folder Instore correction neither downloads Nutstore media nor
  // changes it. Do not let an unrelated Nutstore connection prevent a safe
  // availability-only correction.
  if ((action === 'publish' || action === 'archive') && !isNutstoreConfigured()) {
    return res.status(503).json({ error: nutstoreSetupMessage() });
  }

  const sb = action === 'publish' || action === 'archive' ? getLegacyNutstoreClient() : getStockClient();
  const actor = String((await verifyAdminUser(req))?.email || 'owner-admin-key').trim();
  if (action === 'instore_reconcile') {
    const results = await reconcileInstoreLandedStock(sb, { actor });
    return res.status(200).json({ results });
  }
  if (action === 'instore_correct_received') {
    const results = await correctInstoreReceivedQuantities(sb, items, { actor });
    const failed = results.filter((result) => !result.ok);
    return res.status(failed.length ? 207 : 200).json({
      ok: failed.length === 0,
      action,
      processed: results.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      results,
    });
  }
  // Concurrency 4 works with Nutstore's ~350ms paced fetch — WebDAV downloads
  // are the bottleneck. Higher parallelism risks 503 rate-limit errors even
  // with the shared paced fetcher.
  const NUTSTORE_CONCURRENCY = 4;
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      const raw = items[idx];
      const sku = String(raw.code || '').trim().toUpperCase();
      try {
        const result = action === 'publish'
          ? await publishOne(sb, raw, { overwriteImage })
          : action === 'archive'
            ? await archiveOne(sb, raw)
            : await importInstoreOne(sb, raw, {
              receiptLines: action === 'instore_live' ? [] : raw.receiptLines.map((line) => ({ qty: positiveWhole(line.qty), unit: String(line.unit || '').trim() })),
              stockMode: action === 'instore_live' ? 'positill_live' : 'received',
              actor,
            });
        results[idx] = { sku, ok: true, ...result };
      } catch (err) {
        results[idx] = { sku, ok: false, error: err.message || 'failed', code: err.code || null };
      }
    }
  }

  const workers = Math.min(NUTSTORE_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.ok && r.skipped);
  return res.status(failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    action,
    processed: results.length,
    succeeded: succeeded.length,
    skipped: skipped.length,
    failed: failed.length,
    results,
  });
}
