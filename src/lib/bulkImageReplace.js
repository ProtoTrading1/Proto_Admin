import { parseIntakeFilename, isImageFile, siblingSkuForCopy } from './parseIntakeFilename';
import { compressImage } from './products';
import { readApiJson } from './apiError';

export const BULK_IMAGE_REPLACE_MAX = 500;
export const CLIENT_REQUEST_BATCH = 8;

export function slotFilenameExample(sku, slot) {
  const s = String(sku || 'BASHEWS').trim().toUpperCase();
  if (slot === 1) return `${s}.jpg`;
  return `${s}.${slot}.jpg`;
}

export function catalogRowToSelection(row) {
  const images = row.images || [];
  return {
    // Normalize to match how the selection Map is keyed (trim + uppercase), so
    // selectedSkuSet lookups and the shift-range dedup can't silently desync
    // (a lowercase SKU would otherwise never be found → couldn't be deselected).
    sku: String(row.sku || '').trim().toUpperCase(),
    // Keep the product's barcode/code so an image labelled with the code still
    // matches even after the code was changed to differ from the SKU.
    barcode: row.barcode || row.code || '',
    title: row.title || row.name || row.sku,
    images: [
      images[0] || row.image || '',
      images[1] || '',
      images[2] || '',
      images[3] || '',
    ],
  };
}

/** Match folder files to selected SKUs for a single slot. */
export function buildPreflightMatch(selectedProducts, slot, fileList) {
  const selectedBySku = new Map(
    (selectedProducts || []).map((p) => [String(p.sku).trim().toUpperCase(), p]),
  );
  const selectedSkuSet = new Set(selectedBySku.keys());

  // Map every identifier a file could be named with (the SKU AND the product's
  // barcode/code) to the owning product's SKU. This lets an image labelled with
  // the code match even after the code was changed to differ from the SKU.
  // Two passes so a SKU ALWAYS wins its own key — otherwise a product whose
  // barcode equals another product's SKU could shadow the real owner and route
  // a file to the wrong product.
  const skuByIdentifier = new Map();
  for (const p of selectedProducts || []) {
    const sku = String(p.sku || '').trim().toUpperCase();
    if (sku) skuByIdentifier.set(sku, sku);
  }
  for (const p of selectedProducts || []) {
    const sku = String(p.sku || '').trim().toUpperCase();
    const bc = String(p.barcode || '').trim().toUpperCase();
    if (sku && bc && !skuByIdentifier.has(bc)) skuByIdentifier.set(bc, sku);
  }
  const resolveSku = (code) => skuByIdentifier.get(String(code || '').trim().toUpperCase()) || null;

  const ready = [];
  const wrongSlot = [];
  const extra = [];
  const invalid = [];
  const matchedSkus = new Set();

  for (const file of fileList || []) {
    if (!isImageFile(file)) continue;
    const parsed = parseIntakeFilename(file.name);
    const fileCode = parsed.sourceSku;
    if (!fileCode || parsed.parseError) {
      invalid.push({ file, reason: parsed.parseError || 'invalid' });
      continue;
    }
    // Exact-product-match-first: if the file's FULL code (slot suffix kept)
    // is itself a selected product (a real variant SKU ending in .2/.3/.4),
    // this file is slot 1 of THAT product — never a slot suffix of the base.
    let exactSku = null;
    if (parsed.fullCode && parsed.fullCode !== parsed.sourceSku) {
      exactSku = resolveSku(parsed.fullCode);
    }
    const effectiveSlot = exactSku ? 1 : parsed.imageNumber;
    if (effectiveSlot !== slot) {
      wrongSlot.push({ file, sku: exactSku || fileCode, fileSlot: effectiveSlot });
      continue;
    }
    let sku;
    if (exactSku) {
      sku = exactSku;
    } else if (parsed.copyIndex > 1) {
      // A duplicate "CODE (2).jpg" targets ONLY the sibling record CODE-2.
      // If that sibling isn't selected, it has no valid target — never fall
      // back to the base SKU (that would overwrite the base's image).
      const siblingSku = siblingSkuForCopy(fileCode, parsed.copyIndex);
      sku = resolveSku(siblingSku);
      if (!sku) {
        extra.push({ file, sku: siblingSku });
        continue;
      }
    } else {
      // Match on the file's code, then its barcode/candidate variants
      // ("8774…-10MM", "8774…&8775…", or the base code without a suffix).
      sku = resolveSku(fileCode)
        || (parsed.skuCandidates || []).map(resolveSku).find(Boolean)
        || null;
      if (!sku) {
        extra.push({ file, sku: fileCode });
        continue;
      }
    }
    matchedSkus.add(sku);
    ready.push({
      file,
      sku,
      product: selectedBySku.get(sku),
    });
  }

  const missing = [];
  for (const sku of selectedSkuSet) {
    if (!matchedSkus.has(sku)) {
      missing.push(selectedBySku.get(sku));
    }
  }

  return {
    ready,
    missing,
    wrongSlot,
    extra,
    invalid,
    readyCount: ready.length,
    missingCount: missing.length,
  };
}

export async function preflightSkus(skus, slot, scope = 'live') {
  const res = await fetch('/api/bulk-image-replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'preflight',
      slot,
      scope,
      allowedSkus: skus,
    }),
  });
  return readApiJson(res, { fallback: 'Preflight failed' });
}

async function fileToBase64Blob(file) {
  const compressed = await compressImage(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(compressed);
  });
}

export async function replaceBatch({
  slot,
  scope = 'live',
  allowedSkus,
  readyItems,
  onProgress,
  abortRef,
}) {
  const results = [];
  let done = 0;
  const total = readyItems.length;

  for (let i = 0; i < readyItems.length; i += CLIENT_REQUEST_BATCH) {
    if (abortRef?.current) break;
    const chunk = readyItems.slice(i, i + CLIENT_REQUEST_BATCH);
    onProgress?.({ done, total, phase: 'uploading' });

    const items = await Promise.all(chunk.map(async ({ file, sku }) => ({
      sku,
      filename: file.name,
      contentType: 'image/jpeg',
      base64: await fileToBase64Blob(file),
    })));

    if (abortRef?.current) break;

    const res = await fetch('/api/bulk-image-replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'replace',
        slot,
        scope,
        allowedSkus,
        items,
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 207) {
      for (const row of chunk) {
        results.push({ sku: row.sku, ok: false, error: json.error || 'Batch failed' });
      }
    } else {
      for (const row of json.results || []) {
        results.push(row);
      }
    }

    done += chunk.length;
    onProgress?.({ done, total, phase: 'uploading' });
  }

  return results;
}

export function downloadFailedCsv(results) {
  const failed = (results || []).filter((r) => !r.ok);
  if (!failed.length) return;
  const lines = ['sku,error', ...failed.map((r) => `${r.sku},"${String(r.error || '').replace(/"/g, '""')}"`)];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `image-replace-failed-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
