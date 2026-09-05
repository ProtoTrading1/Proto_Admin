import { createClient } from '@supabase/supabase-js';
import { catalogueDescription, catalogueDisplayTitle } from '../lib/product-loader-display.mjs';
import { requireOwner } from './_admin-auth.js';
import { logProductLoaderAudit } from './_product-loader-audit.js';
import { labelsToDbFields } from './_taxonomy-utils.js';
import { fetchProductLookupMap, findProductBySku } from './_sku-match.js';
import { canonicalPublishValues } from '../lib/catalogue-safety.mjs';
import { normalizeUnitsOfIssue } from '../lib/selling-unit.mjs';
import { resolveProductByCode } from './_sql-provider.js';
import { previewPublishBlock } from '../lib/preview-publish-guard.mjs';
import { isImageProcessingAssetUrl } from './_staging-storage.js';

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const SLOT_FIELDS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  // Preview is a review-only environment. This is deliberately enforced on
  // the server before a catalogue client is created, not merely by disabling a
  // button in the browser.
  const previewBlock = previewPublishBlock();
  if (previewBlock) return res.status(previewBlock.status).json({
    error: previewBlock.error,
    code: previewBlock.code,
  });

  const {
    code,
    title,
    price,
    imageUrl,
    imageSlot = 1,
    imageSource = 'upload',
    overwriteImage = false,
    category,
    categoryPath,
    subcategoryOne,
    subcategoryTwo,
    description,
    publishedBy,
    publishMode = 'direct',
    categoryConfidence,
    stockQty,
    availableStock,
    barcode: bodyBarcode,
    filename,
    displayCode,
    sqlRow,
    websiteRow,
    images,
    requireNew = false,
    unitsOfIssue,
    packDescription,
  } = req.body || {};

  // Normalize the SKU the SAME way upload-product-image sanitizes its storage
  // path (`[^A-Z0-9_-]` stripped), so the DB key and the image object prefix
  // stay in lock-step — otherwise a code like "T BAG 91" stores images under
  // TBAG91/ but a row keyed "T BAG 91" that nothing can re-target.
  const sku = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!sku) return res.status(400).json({ error: 'code is required' });
  if (!category) return res.status(400).json({ error: 'category is required' });

  // Accept either a single image (imageUrl + imageSlot — existing callers) or a
  // full set via `images: [{ slot, url }]` (the New Product authoring flow), and
  // write every provided slot in one publish.
  const slotUrls = {};
  if (Array.isArray(images)) {
    for (const img of images) {
      const s = Math.min(4, Math.max(1, Number(img?.slot) || 0));
      const u = String(img?.url || '').trim();
      if (s >= 1 && s <= 4 && u) slotUrls[s] = u;
    }
  }
  const singleSlot = Math.min(4, Math.max(1, Number(imageSlot) || 1));
  if (!Object.keys(slotUrls).length && imageUrl) slotUrls[singleSlot] = String(imageUrl).trim();
  const filledSlots = Object.keys(slotUrls).map(Number).sort((a, b) => a - b);
  if (!filledSlots.length) return res.status(400).json({ error: 'At least one image is required' });
  if (Object.values(slotUrls).some((url) => isImageProcessingAssetUrl(url))) {
    return res.status(409).json({
      error: 'Image Processing Centre candidates must be applied through the Centre after review. The direct publish route cannot use them.',
      code: 'image_processing_centre_only',
    });
  }

  const primarySlot = slotUrls[1] ? 1 : filledSlots[0];
  const imageUrlPrimary = slotUrls[primarySlot];
  const imageField = SLOT_FIELDS[primarySlot - 1];
  const imageFields = {};
  for (const s of filledSlots) imageFields[SLOT_FIELDS[s - 1]] = slotUrls[s];

  const sb = getStockClient();

  const { data: existing, error: lookupErr } = await sb
    .from('website_stock')
    .select('*')
    .eq('sku', sku)
    .maybeSingle();

  if (lookupErr) return res.status(400).json({ error: lookupErr.message });

  // "Author a new product" must never silently overwrite an existing SKU.
  if (requireNew && existing) {
    return res.status(409).json({
      error: 'A product with this code already exists. Use the Single Image flow to add an image to it.',
      code: 'exists',
    });
  }

  if (existing && !overwriteImage) {
    const clash = filledSlots.filter((s) => existing[SLOT_FIELDS[s - 1]]);
    if (clash.length) {
      return res.status(409).json({
        error: `Image slot${clash.length > 1 ? 's' : ''} ${clash.join(', ')} already ${clash.length > 1 ? 'have' : 'has'} an image. Confirm overwrite to replace.`,
        code: 'image_exists',
      });
    }
  }

  const now = new Date().toISOString();
  const erpBarcode = String(bodyBarcode || existing?.barcode || sku).trim();
  let canonicalProduct = null;
  try {
    const productMap = await fetchProductLookupMap(
      sb,
      [erpBarcode],
      'sku, sell_price, stock_qty, available_stock, units_of_issue',
    );
    canonicalProduct = findProductBySku(productMap, erpBarcode);
  } catch (error) {
    return res.status(503).json({
      error: `Catalogue safety check could not verify the ERP product: ${error.message}`,
      code: 'catalogue_safety_unavailable',
    });
  }

  // Re-read Positill on the server immediately before publishing. The lookup
  // screen may have been open for a while, and the synchronised products/cache
  // tables can lag by a sync interval. A new website product must never be
  // created from that older price when the live bridge is unavailable.
  const resolvedPositill = await resolveProductByCode(erpBarcode).catch(() => ({
    product: null,
    dataSource: null,
    bridgeAttempted: true,
  }));
  if (!requireNew && !existing && resolvedPositill.dataSource !== 'erp_sql') {
    return res.status(503).json({
      error: 'Publishing paused because the live Positill price could not be verified. Retry when Live Positill SQL is connected.',
      code: 'live_price_unavailable',
      sku,
    });
  }

  const safeValues = canonicalPublishValues({
    product: canonicalProduct,
    livePositill: resolvedPositill.product,
    positillSource: resolvedPositill.dataSource,
    existing,
    submitted: {
      price,
      stockQty,
      availableStock,
      erpPriceExVat: sqlRow?.price,
    },
    priceBasis: requireNew ? 'vat_inclusive' : 'erp_ex_vat',
  });
  if (safeValues.blocked) {
    return res.status(422).json({
      error: safeValues.message,
      code: safeValues.code,
      sku,
    });
  }

  const catalogItem = {
    code: sku,
    displayCode,
    title,
    description,
    barcode: erpBarcode,
    sqlRow: sqlRow || null,
    websiteRow: websiteRow || null,
  };
  // For an authored new product the admin's typed title IS the source of truth —
  // don't run it through catalogueDisplayTitle, which blanks any title that
  // looks like the code/barcode (e.g. a commodity SKU named the same as itself).
  const resolvedTitle = requireNew
    ? String(title || '').trim()
    : catalogueDisplayTitle(catalogItem);
  const resolvedDescription = catalogueDescription(catalogItem);
  const resolvedUnitsOfIssue = normalizeUnitsOfIssue(
    unitsOfIssue || existing?.units_of_issue || canonicalProduct?.units_of_issue || 'EACH',
  );

  // When the caller supplies a full category path (the loader's cascading
  // picker), persist EVERY level via labelsToDbFields — including
  // subcategory_three/four and the subcategory_extra overflow — so a move into
  // a deep subcategory actually sticks. Legacy callers (no categoryPath) keep
  // the old behaviour: set category + sub1/sub2 only and leave any deeper
  // levels already stored untouched.
  const cleanPath = Array.isArray(categoryPath)
    ? categoryPath.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  const catFields = cleanPath.length
    ? labelsToDbFields(cleanPath)
    : {
      category: String(category || '').trim(),
      subcategory_one: String(subcategoryOne || category || '').trim(),
      subcategory_two: subcategoryTwo ? String(subcategoryTwo).trim() : null,
    };

  const patch = {
    title: resolvedTitle,
    // Never trust browser-supplied price/stock when a synchronised ERP product
    // exists. This closes both the double-VAT and stale-stock publication paths.
    price: safeValues.price,
    stock_qty: safeValues.stockQty,
    available_stock: safeValues.availableStock,
    units_of_issue: resolvedUnitsOfIssue,
    ...catFields,
    ...imageFields,
    updated_at: now,
  };

  if (resolvedDescription) patch.original_description = resolvedDescription;
  if (packDescription !== undefined) patch.pack_description = String(packDescription || '').trim();
  let action;
  let writeError;

  if (existing) {
    action = 'update';
    const { error } = await sb.from('website_stock').update(patch).eq('sku', sku);
    writeError = error;
  } else {
    action = 'create';
    const insertRow = {
      sku,
      barcode: erpBarcode,
      title: patch.title,
      price: patch.price,
      units_of_issue: patch.units_of_issue,
      pack_description: patch.pack_description || '',
      ...catFields,
      original_description: patch.original_description || '',
      stock_qty: patch.stock_qty ?? 0,
      available_stock: patch.available_stock ?? patch.stock_qty ?? 0,
      image_url_one: null,
      image_url_two: null,
      image_url_three: null,
      image_url_four: null,
      ...imageFields,
      // An authored product has no ERP stock feed, so a 0-stock row would be
      // hidden by isPublishableOnWebsite. Keep it live regardless — the admin
      // explicitly chose to publish it (auto-OOS archiving is off anyway).
      ...(requireNew ? { keep_live_when_oos: true } : {}),
      updated_at: now,
    };
    const { error } = await sb.from('website_stock').insert(insertRow);
    writeError = error;
  }

  if (writeError) {
    // Concurrent authoring of the same new code: the unique sku key fires here
    // after both callers passed the existence check. Return the clean 409.
    if (writeError.code === '23505') {
      return res.status(409).json({
        error: 'A product with this code already exists. Use the Single Image flow to add an image to it.',
        code: 'exists',
      });
    }
    return res.status(400).json({ error: writeError.message });
  }

  await logProductLoaderAudit(sb, {
    sku,
    action,
    source: 'manual_product_loader',
    publishMode: String(publishMode || 'direct'),
    imageSlot: primarySlot,
    imageSource: String(imageSource || 'upload'),
    categoryConfidence: categoryConfidence != null ? Number(categoryConfidence) : null,
    oldValues: existing
      ? {
        title: existing.title,
        price: existing.price,
        category: existing.category,
        subcategory_one: existing.subcategory_one,
        [imageField]: existing[imageField],
      }
      : null,
    newValues: {
      outcome: 'published',
      title: patch.title,
      price: patch.price,
      unitsOfIssue: patch.units_of_issue,
      packDescription: patch.pack_description ?? existing?.pack_description ?? '',
      priceSource: safeValues.priceSource || (requireNew ? 'manual_incl_vat' : null),
      category: patch.category,
      subcategoryOne: patch.subcategory_one,
      imageUrl: imageUrlPrimary,
      imageSlot: primarySlot,
      imageSlots: filledSlots,
      imageSource,
      publishMode,
      safetyCorrections: safeValues.corrections,
      filename: String(filename || '').trim() || null,
    },
    publishedBy: String(publishedBy || '').trim() || null,
  });

  return res.status(200).json({ ok: true, action, sku });
}
