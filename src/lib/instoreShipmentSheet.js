import { normalizeReceiptUnit } from '../../lib/received-stock-unit.mjs';

function normaliseHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function normaliseSku(value) {
  return String(value || '').trim().toUpperCase();
}

function readQty(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  const qty = Number(text);
  return Number.isSafeInteger(qty) && qty >= 1 ? qty : null;
}

function findColumn(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function asFiles(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return Array.from(value).filter(Boolean);
}

function appendUnique(existing = [], incoming = []) {
  return [...new Set([...existing, ...incoming].filter(Boolean))];
}

function mergeReceiptLines(existing = new Map(), incoming = new Map()) {
  const merged = new Map();
  for (const [sku, lines] of existing) {
    merged.set(sku, (lines || []).map((line) => ({ ...line })));
  }
  for (const [sku, lines] of incoming) {
    const current = merged.get(sku) || [];
    for (const line of lines || []) {
      const sameUnit = current.find((entry) => entry.unit === line.unit);
      if (sameUnit) sameUnit.qty += line.qty;
      else current.push({ ...line });
    }
    merged.set(sku, current);
  }
  return merged;
}

/**
 * Merge separately selected shipment workbooks without losing earlier files.
 * Re-selecting an already-loaded file is rejected so quantities cannot be
 * counted twice by accident.
 */
export function mergeReceivedStockSheets(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingFiles = new Set([
    ...(existing.quantityFiles || []),
    ...(existing.departmentFiles || []),
  ]);
  const repeatedFiles = [
    ...(incoming.quantityFiles || []),
    ...(incoming.departmentFiles || []),
  ].filter((name) => existingFiles.has(name));
  if (repeatedFiles.length) {
    throw new Error(`Already loaded: ${[...new Set(repeatedFiles)].join(', ')}. Choose only the remaining Excel files.`);
  }

  const quantities = new Map(existing.quantities || []);
  const duplicates = new Set(existing.duplicates || []);
  for (const [sku, qty] of incoming.quantities || []) {
    if (quantities.has(sku)) duplicates.add(sku);
    quantities.set(sku, (quantities.get(sku) || 0) + qty);
  }

  const sellingUnits = new Map(existing.sellingUnits || []);
  const unitConflicts = new Set(existing.unitConflicts || []);
  for (const [sku, unit] of incoming.sellingUnits || []) {
    if (sellingUnits.has(sku) && sellingUnits.get(sku) !== unit) unitConflicts.add(sku);
    else sellingUnits.set(sku, unit);
  }

  const quantityFiles = appendUnique(existing.quantityFiles, incoming.quantityFiles);
  const departmentFiles = appendUnique(existing.departmentFiles, incoming.departmentFiles);
  return {
    quantities,
    receiptLines: mergeReceiptLines(existing.receiptLines, incoming.receiptLines),
    sellingUnits,
    duplicates: appendUnique([...duplicates], incoming.duplicates),
    invalid: appendUnique(existing.invalid, incoming.invalid),
    unitConflicts: appendUnique([...unitConflicts], incoming.unitConflicts),
    quantityFiles,
    departmentFiles,
    filename: [...quantityFiles, ...departmentFiles].join(', '),
  };
}

/**
 * Read the two exports that travel with a landed shipment:
 * - Stock Received: exact supplier receipt lines per SKU (PCS or PKS)
 * - Positill department invoice: canonical customer selling units per SKU
 *
 * A supplier invoice's UNIT marks the received quantity: PKS is already a
 * sellable pack, while PCS is converted through Positill's selling unit.
 * Only a department invoice, identified by its Department
 * column and no received-quantity column, may supply the Positill unit.
 */
export async function parseReceivedStockSheet(fileOrFiles, { requireQuantities = true } = {}) {
  const files = asFiles(fileOrFiles);
  if (!files.length) throw new Error('Choose the Stock Received Excel or Positill department invoice.');
  const XLSX = await import('xlsx');

  const quantities = new Map();
  const receiptLines = new Map();
  const sellingUnits = new Map();
  const duplicates = new Set();
  const invalid = [];
  const unitConflicts = new Set();
  const quantityFiles = [];
  const departmentFiles = [];

  for (const file of files) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) continue;
    const table = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const headerIndex = table.findIndex((row) => {
      const headers = row.map(normaliseHeader);
      return findColumn(headers, [/^(sku|code|item code|product code|stock code|barcode)$/]) >= 0;
    });
    if (headerIndex < 0) continue;
    const headers = table[headerIndex].map(normaliseHeader);
    const skuColumn = findColumn(headers, [/^(sku|code|item code|product code|stock code|barcode)$/]);
    const qtyColumn = findColumn(headers, [/^(qty|quantity|received|received qty|received quantity|stock received|quantity received|actual received)$/]);
    const unitColumn = findColumn(headers, [/^(unit|unit of issue|units of issue)$/]);
    const departmentColumn = findColumn(headers, [/^department$/]);

    if (qtyColumn >= 0) {
      quantityFiles.push(file.name);
      for (const row of table.slice(headerIndex + 1)) {
        const sku = normaliseSku(row[skuColumn]);
        if (!sku) continue;
        const qty = readQty(row[qtyColumn]);
        if (!qty) { invalid.push(sku); continue; }
        // An omitted UNIT column is the legacy Stock Received export, whose
        // quantity is physical pieces. Supplier invoices explicitly use PKS
        // for already-sellable packs.
        const receiptUnit = normalizeReceiptUnit(unitColumn >= 0 ? row[unitColumn] : 'PCS');
        if (!receiptUnit) { invalid.push(sku); continue; }
        if (quantities.has(sku)) duplicates.add(sku);
        quantities.set(sku, (quantities.get(sku) || 0) + qty);
        const existing = receiptLines.get(sku) || [];
        const sameUnit = existing.find((entry) => entry.unit === receiptUnit);
        if (sameUnit) sameUnit.qty += qty;
        else existing.push({ qty, unit: receiptUnit });
        receiptLines.set(sku, existing);
      }
      continue;
    }

    if (unitColumn >= 0 && departmentColumn >= 0) {
      departmentFiles.push(file.name);
      for (const row of table.slice(headerIndex + 1)) {
        const sku = normaliseSku(row[skuColumn]);
        const unit = String(row[unitColumn] || '').trim();
        if (!sku || !unit) continue;
        if (sellingUnits.has(sku) && sellingUnits.get(sku) !== unit) unitConflicts.add(sku);
        else sellingUnits.set(sku, unit);
      }
    }
  }
  if (requireQuantities && !quantities.size) throw new Error('No positive received quantities were found in the Stock Received file.');
  return {
    quantities,
    receiptLines,
    sellingUnits,
    duplicates: [...duplicates],
    invalid,
    unitConflicts: [...unitConflicts],
    quantityFiles,
    departmentFiles,
    filename: files.map((file) => file.name).join(', '),
  };
}
