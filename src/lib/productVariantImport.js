import { isImageFile } from './parseIntakeFilename';

const cleanSku = (value) => String(value ?? '').trim().toUpperCase();
const normalizeHeader = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const SKU_HEADERS = new Set(['SKU', 'WEBSITE SKU', 'PRODUCT SKU', 'ITEM CODE', 'PRODUCT CODE', 'CODE']);
const TITLE_HEADERS = new Set(['TITLE', 'NAME', 'PRODUCT', 'DESCRIPTION']);

function isBarcodeHeader(value) {
  const header = normalizeHeader(value);
  return header === 'BARCODE'
    || header === 'BAR CODE'
    || header === 'EAN'
    || header === 'EAN13'
    || header === 'GTIN'
    || header === 'UPC'
    || header.includes('BARCODE')
    || header.includes('EAN')
    || header.includes('GTIN')
    || header.includes('UPC');
}

/** Parse the variant workbook without dropping its barcode column. */
export function parseVariantRows(table) {
  if (!table?.length) throw new Error('That file appears to be empty.');
  let headerIdx = -1;
  let skuCol = -1;
  let titleCol = -1;
  let barcodeCol = -1;
  for (let i = 0; i < Math.min(table.length, 10); i += 1) {
    const cells = table[i] || [];
    const normalized = cells.map(normalizeHeader);
    const sc = normalized.findIndex((cell) => SKU_HEADERS.has(cell));
    let tc = normalized.findIndex((cell, idx) => idx !== sc && TITLE_HEADERS.has(cell));
    if (tc === -1) tc = normalized.findIndex((cell, idx) => idx !== sc && [...TITLE_HEADERS].some((header) => cell.includes(header)));
    const bc = normalized.findIndex((cell, idx) => idx !== sc && idx !== tc && isBarcodeHeader(cell));
    if (sc !== -1 && tc !== -1 && bc !== -1 && sc !== tc && sc !== bc && tc !== bc) {
      headerIdx = i;
      skuCol = sc;
      titleCol = tc;
      barcodeCol = bc;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find SKU, barcode and TITLE columns. The first rows must include SKU, BARCODE (or EAN/GTIN/UPC), and TITLE/NAME/PRODUCT/DESCRIPTION headers.');
  }

  const rowsBySku = new Map();
  for (let i = headerIdx + 1; i < table.length; i += 1) {
    const row = table[i] || [];
    const sku = cleanSku(row[skuCol]);
    const title = String(row[titleCol] ?? '').trim();
    const barcode = String(row[barcodeCol] ?? '').trim();
    if (!sku || !title) continue;
    rowsBySku.set(sku, { sku, title, barcode });
  }
  const rows = [...rowsBySku.values()];
  if (!rows.length) throw new Error('No rows with both a SKU and a title were found.');
  return rows;
}

export async function parseVariantImportSheet(file) {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('No sheet found in that file.');
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const rows = parseVariantRows(table);
  const missingBarcode = rows.filter((row) => !row.barcode);
  if (missingBarcode.length) {
    throw new Error(`${missingBarcode.length} row${missingBarcode.length === 1 ? '' : 's'} do not have a barcode. Every new website SKU needs its Positill barcode.`);
  }
  return rows;
}

/**
 * Match local files conservatively: SKU.jpg is slot 1 and SKU.2.jpg through
 * SKU.4.jpg are the extra slots. Exact SKU wins, so a real SKU ending in .2
 * is never stripped when it exists in the workbook.
 */
export function matchVariantImages(rows, files) {
  const rowSkus = new Set((rows || []).map((row) => cleanSku(row.sku)));
  const matches = new Map([...rowSkus].map((sku) => [sku, new Map()]));
  const unmatched = [];
  const duplicates = [];

  for (const file of Array.from(files || []).filter(isImageFile)) {
    const name = String(file.name || '');
    const dot = name.lastIndexOf('.');
    const stem = cleanSku(dot > 0 ? name.slice(0, dot) : name);
    let sku = rowSkus.has(stem) ? stem : '';
    let slot = 1;

    if (!sku) {
      const slotMatch = stem.match(/^(.*)\.([2-4])$/);
      if (slotMatch && rowSkus.has(slotMatch[1])) {
        sku = slotMatch[1];
        slot = Number(slotMatch[2]);
      }
    }

    if (!sku) {
      unmatched.push(file);
      continue;
    }
    const slots = matches.get(sku);
    if (slots.has(slot)) {
      duplicates.push({ sku, slot, filenames: [slots.get(slot).name, file.name] });
      continue;
    }
    slots.set(slot, file);
  }

  const items = (rows || []).map((row) => {
    const sku = cleanSku(row.sku);
    const slots = matches.get(sku) || new Map();
    return {
      ...row,
      sku,
      images: [...slots.entries()]
        .map(([slot, file]) => ({ slot, file, filename: file.name }))
        .sort((a, b) => a.slot - b.slot),
      hasPrimaryImage: slots.has(1),
      duplicateSlots: duplicates.filter((item) => item.sku === sku),
    };
  });

  return { items, unmatched, duplicates };
}

export function isExistingExcelArchiveRow(row) {
  return Boolean(
    row?.existing
    && row?.existingLocation === 'archive'
    && String(row?.archivedBy || row?.archived_by || '').startsWith('excel-images'),
  );
}

export function variantRowState(row) {
  if (row.existing) {
    if (isExistingExcelArchiveRow(row)) {
      return { ready: true, reason: 'Ready to include in this batch — existing images will not be changed' };
    }
    return { ready: false, reason: `SKU already exists ${row.existingLocation === 'archive' ? 'in Archive' : 'on the website'} — blocked to protect its images` };
  }
  if (!row.sourceFound) return { ready: false, reason: 'Barcode not found in the product source' };
  if (!row.price || Number(row.price) <= 0) return { ready: false, reason: 'No valid website price found' };
  if (row.duplicateSlots?.length) return { ready: false, reason: 'More than one file targets the same image slot' };
  if (!row.hasPrimaryImage) return { ready: false, reason: 'Main image missing (use SKU.jpg)' };
  return { ready: true, reason: 'Ready' };
}
