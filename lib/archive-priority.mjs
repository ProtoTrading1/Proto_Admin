export const ARCHIVE_PRIORITY_STORAGE_KEY = 'proto-archive-excel-priority-v1';
export const ARCHIVE_PRIORITY_MAX = 100;
export const ARCHIVE_PRIORITY_TTL_MS = 24 * 60 * 60 * 1000;
export const EXCEL_IMAGE_ARCHIVE_SOURCE = 'excel-images';

// Keep the complete archived_by marker comfortably below legacy varchar
// limits used by older catalogue deployments. A UUID (36 chars) fits.
const SAFE_BATCH_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const cleanSku = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

export function normalizeArchivePrioritySkus(values) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const sku = cleanSku(value);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    unique.push(sku);
    if (unique.length >= ARCHIVE_PRIORITY_MAX) break;
  }
  return unique;
}

export function prioritizeRowsBySku(rows, prioritySkus) {
  const rank = new Map(normalizeArchivePrioritySkus(prioritySkus).map((sku, index) => [sku, index]));
  if (!rank.size) return rows;
  return [...(rows || [])].sort((a, b) => {
    const aRank = rank.get(cleanSku(a?.sku));
    const bRank = rank.get(cleanSku(b?.sku));
    if (aRank == null && bRank == null) return 0;
    if (aRank == null) return 1;
    if (bRank == null) return -1;
    return aRank - bRank;
  });
}

/**
 * Store a small, non-sensitive batch marker in archived_by. This avoids a
 * schema migration while making one Excel intake discoverable by every tab.
 */
export function excelImageArchiveSource(batchId) {
  const cleanBatchId = String(batchId ?? '').trim();
  return SAFE_BATCH_ID_RE.test(cleanBatchId)
    ? `${EXCEL_IMAGE_ARCHIVE_SOURCE}:${cleanBatchId}`
    : EXCEL_IMAGE_ARCHIVE_SOURCE;
}

export function isExcelImageArchiveSource(value) {
  const source = String(value ?? '').trim();
  return source === EXCEL_IMAGE_ARCHIVE_SOURCE
    || source.startsWith(`${EXCEL_IMAGE_ARCHIVE_SOURCE}:`);
}

export function isProductLoaderImageArchiveSource(value) {
  const source = String(value ?? '').trim();
  return source === 'nutstore' || isExcelImageArchiveSource(source);
}

export function isNewImageArchiveSource(value) {
  return isProductLoaderImageArchiveSource(value);
}

export function johannesburgArchiveDateKey(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isNewProductLoaderImageArchiveRow(row) {
  return isNewImageArchiveSource(row?.archived_by ?? row?.archivedBy);
}

export function filterProductArchiveSection(rows, section = 'older') {
  const list = Array.isArray(rows) ? rows : [];
  if (section === 'new-images') {
    return list.filter((row) => isNewProductLoaderImageArchiveRow(row));
  }
  if (section === 'older') {
    return list.filter((row) => !isNewProductLoaderImageArchiveRow(row));
  }
  return list;
}

export function latestExcelImageBatchSource(rows) {
  const newestBatchRow = (Array.isArray(rows) ? rows : []).find((row) => {
    const source = String(row?.archived_by ?? '').trim();
    return source.startsWith(`${EXCEL_IMAGE_ARCHIVE_SOURCE}:`);
  });
  return newestBatchRow ? String(newestBatchRow.archived_by).trim() : '';
}

/**
 * Put every row from the newest server-recorded Excel batch first. The input
 * already has the normal Archive ordering, so a stable partition preserves
 * both the workbook insertion order and the ordering of all older products.
 */
export function prioritizeLatestExcelImageBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const newestSource = latestExcelImageBatchSource(list);
  if (!newestSource) return list;
  return [
    ...list.filter((row) => String(row?.archived_by ?? '').trim() === newestSource),
    ...list.filter((row) => String(row?.archived_by ?? '').trim() !== newestSource),
  ];
}

export function saveArchivePrioritySkus(values) {
  const skus = normalizeArchivePrioritySkus(values);
  try {
    localStorage.setItem(ARCHIVE_PRIORITY_STORAGE_KEY, JSON.stringify({
      skus,
      savedAt: Date.now(),
    }));
  } catch { /* local storage may be unavailable */ }
  return skus;
}

export function readArchivePrioritySkus() {
  try {
    const stored = JSON.parse(localStorage.getItem(ARCHIVE_PRIORITY_STORAGE_KEY) || 'null');
    if (Array.isArray(stored)) return normalizeArchivePrioritySkus(stored);
    if (!stored || !Array.isArray(stored.skus)) return [];

    const savedAt = Number(stored.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > ARCHIVE_PRIORITY_TTL_MS) {
      localStorage.removeItem(ARCHIVE_PRIORITY_STORAGE_KEY);
      return [];
    }
    return normalizeArchivePrioritySkus(stored.skus);
  } catch {
    return [];
  }
}
