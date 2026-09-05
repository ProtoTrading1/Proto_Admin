/** Client-side filename parser — mirrors api/_product-loader-filename.js */
import { codeLookupCandidates, firstCodeToken } from '../../lib/code-normalize.mjs';

const IMAGE_COLUMNS = ['image_url_one', 'image_url_two', 'image_url_three', 'image_url_four'];
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const SLOT_SUFFIX = /^(?<sku>.+)\.(?<slot>[2-4])$/i;
const NOISE_PATTERNS = [
  /\s+copy$/i,
  /\s*\(\d+\)$/,
  /[_\s]+(front|back|side|detail|hero)$/i,
];

export function parseIntakeFilename(filename) {
  const raw = String(filename || '').trim();
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  let working = stem.trim();

  if (!working) {
    return {
      sourceSku: '',
      displayCode: '',
      imageNumber: 1,
      imageColumn: IMAGE_COLUMNS[0],
      parseError: 'empty_filename',
    };
  }

  // Capture + strip the OS "(2)" duplicate marker FIRST, before the slot
  // suffix is read — otherwise "CODE-2 (2).jpg" (a duplicate of a slot-2
  // image) would hide the slot and corrupt the SKU.
  let copyIndex = 1;
  // The OS duplicate marker "(2)" — with OR without a leading space
  // ("CODE (2).jpg" and "CODE(2).jpg" both mean a duplicate/variant of CODE).
  const dupMatch = working.match(/\s*\((\d+)\)$/);
  if (dupMatch) {
    copyIndex = Math.max(1, Number.parseInt(dupMatch[1], 10) || 1);
    working = working.replace(/\s*\(\d+\)$/, '').trim();
  }

  // The full code KEEPS the slot suffix (only the copy marker + noise are
  // stripped). A real variant SKU that literally ends in .2/.3/.4 can then be
  // matched exactly by the resolver before the slot suffix is interpreted.
  let fullWorking = working;
  for (const pattern of NOISE_PATTERNS) {
    fullWorking = fullWorking.replace(pattern, '').trim();
  }
  const fullCode = fullWorking.toUpperCase();

  let imageNumber = 1;
  const slotMatch = working.match(SLOT_SUFFIX);
  if (slotMatch?.groups?.sku) {
    working = String(slotMatch.groups.sku || '').trim();
    imageNumber = Math.min(4, Math.max(1, Number.parseInt(slotMatch.groups.slot || '1', 10) || 1));
  }

  for (const pattern of NOISE_PATTERNS) {
    working = working.replace(pattern, '').trim();
  }

  const displayCode = working;
  const sourceSku = working.toUpperCase();

  return {
    sourceSku,
    fullCode,
    displayCode,
    imageNumber,
    copyIndex,
    imageColumn: IMAGE_COLUMNS[imageNumber - 1] || IMAGE_COLUMNS[0],
    parseError: sourceSku.length < 2 ? 'sku_too_short' : null,
    // Messy names ("87747748383-10mm", "8774…&8774…") match on the first
    // code before any separator.
    skuCandidates: codeLookupCandidates(working),
    primarySku: firstCodeToken(working),
  };
}

/**
 * SKU a duplicate image publishes to: copy #1 keeps the base code, copy #2+
 * become sibling records (CODE, CODE-2, CODE-3…) sharing the same barcode.
 */
export function siblingSkuForCopy(baseSku, copyIndex) {
  const sku = String(baseSku || '').trim().toUpperCase();
  const n = Math.max(1, Number(copyIndex) || 1);
  return n <= 1 ? sku : `${sku}-${n}`;
}

export function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  return IMAGE_EXT.test(file.name || '');
}

export const WEBSITE_STATUS_LABELS = {
  live: 'Live',
  dormant: 'Dormant',
  new: 'New Product',
  not_found: 'Not Found',
};

export function websiteStatusLabel(status) {
  return WEBSITE_STATUS_LABELS[status] || status || '—';
}

export function classifyDormantRow(row) {
  const hasCategory = Boolean(row.category && row.subcategoryOne);
  const hasImages = Boolean(
    row.imageUrlOne || row.imageUrlTwo || row.imageUrlThree || row.imageUrlFour,
  );
  if (!hasCategory) return 'waitingCategories';
  if (!hasImages) return 'waitingImages';
  if (!row.price || Number(row.price) <= 0) return 'waitingApproval';
  return 'readyToPublish';
}

export const DORMANT_SECTION_LABELS = {
  waitingImages: 'Waiting Images',
  waitingCategories: 'Waiting Categories',
  waitingApproval: 'Waiting Approval',
  readyToPublish: 'Ready To Publish',
};

export function exportBatchReportCsv(items, summary) {
  const header = ['Filename', 'SKU', 'Description', 'Slot', 'Group', 'Status', 'Price', 'SOH', 'Error'];
  const lines = [header.join(',')];
  for (const row of items) {
    lines.push([
      row.filename,
      row.code || '',
      `"${String(row.title || '').replace(/"/g, '""')}"`,
      row.imageSlot || 1,
      row.group || '',
      row.status || '',
      row.price ?? '',
      row.stockOnHand ?? row.sqlRow?.available ?? '',
      `"${String(row.processError || row.parseError || '').replace(/"/g, '""')}"`,
    ].join(','));
  }
  if (summary) {
    lines.push('');
    lines.push(`Summary,Found,${summary.total},Matched,${summary.matched}`);
  }
  return lines.join('\n');
}
