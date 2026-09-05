// Bulk title replace — parse a SKU/TITLE spreadsheet, preview the matches
// against the live catalogue, then apply. Titles are written to
// website_stock.title (see api/bulk-description-replace.js).

export const BULK_DESCRIPTION_MAX = 5000;

const TITLE_HEADERS = ['TITLE', 'NAME', 'PRODUCT', 'DESCRIPTION'];
const SKU_HEADERS = ['SKU', 'WEBSITE SKU', 'PRODUCT SKU', 'ITEM CODE', 'PRODUCT CODE', 'CODE'];

const normalizeSku = (value) => String(value ?? '').trim().toUpperCase();

/** Parse worksheet rows by exact SKU so shared barcodes can never merge variants. */
export function parseDescriptionRows(table) {
  if (!table?.length) throw new Error('That file appears to be empty.');

  let headerIdx = -1;
  let skuCol = -1;
  let titleCol = -1;
  for (let i = 0; i < Math.min(table.length, 10); i += 1) {
    const rowCells = (table[i] || []).map((c) => String(c || '').trim().toUpperCase());
    const sc = rowCells.findIndex((c) => SKU_HEADERS.includes(c));
    let tc = rowCells.findIndex((c, idx) => idx !== sc && TITLE_HEADERS.includes(c));
    if (tc === -1) tc = rowCells.findIndex((c, idx) => idx !== sc && TITLE_HEADERS.some((h) => c.includes(h)));
    if (sc !== -1 && tc !== -1 && sc !== tc) { headerIdx = i; skuCol = sc; titleCol = tc; break; }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find SKU and TITLE columns. The first rows must include a SKU header and a TITLE (or NAME/PRODUCT/DESCRIPTION) header.');
  }

  // Last row wins only when the same exact SKU repeats as a later correction.
  const map = new Map();
  for (let i = headerIdx + 1; i < table.length; i += 1) {
    const row = table[i] || [];
    const sku = normalizeSku(row[skuCol]);
    const title = String(row[titleCol] ?? '').trim();
    if (!sku || !title) continue;
    map.set(sku, title);
  }
  const items = [...map.entries()].map(([sku, title]) => ({ sku, title }));
  if (!items.length) throw new Error('No rows with both a SKU and a title were found.');
  if (items.length > BULK_DESCRIPTION_MAX) {
    throw new Error(`Too many rows (${items.length}). Max ${BULK_DESCRIPTION_MAX} per run.`);
  }
  return items;
}

/** Parse an .xlsx/.csv with SKU + (TITLE|NAME|PRODUCT|DESCRIPTION) → [{sku, title}]. */
export async function parseDescriptionSheet(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('No sheet found in that file.');
  const table = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return parseDescriptionRows(table);
}

/** Look up the current title for each exact SKU; merge in the new title. */
export async function previewDescriptions(items) {
  const res = await fetch('/api/bulk-description-replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'preview', skus: items.map((i) => i.sku) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Preview failed');
  const bySku = new Map(items.map((i) => [normalizeSku(i.sku), i.title]));
  return (json.rows || []).map((r) => ({
    ...r,
    newTitle: bySku.get(normalizeSku(r.sku)) || '',
    unchanged: r.found && (r.currentTitle || '').trim() === (bySku.get(normalizeSku(r.sku)) || '').trim(),
  }));
}

/** Apply the title updates. Returns { updated, notFound, failed, results }. */
export async function applyDescriptions(items) {
  const res = await fetch('/api/bulk-description-replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'apply', items }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Apply failed');
  return json;
}

/** Download a CSV of SKUs that had no matching product. */
export function downloadUnmatchedCsv(rows) {
  const unmatched = (rows || []).filter((r) => !r.found);
  if (!unmatched.length) return;
  const lines = [['SKU', 'NEW TITLE'], ...unmatched.map((r) => [r.sku, r.newTitle || ''])];
  const csv = lines
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'unmatched-skus.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
