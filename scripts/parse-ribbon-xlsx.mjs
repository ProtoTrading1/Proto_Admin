#!/usr/bin/env node
/**
 * Parse Ribbon_Website_Integration.xlsx → Textiles ribbon taxonomy JSON
 */
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const FILE = '/workspace/data/Ribbon_Website_Integration.xlsx';
const OUT = '/workspace/data/ribbon-taxonomy-parsed.json';

const wb = XLSX.readFile(FILE, { cellDates: true, raw: false });

function norm(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (s.toLowerCase() === 'nan') return '';
  return s;
}

function splitPath(pathStr) {
  return norm(pathStr)
    .split(/\s*>\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function ensureChild(parent, name, level) {
  if (!parent.children[name]) {
    parent.children[name] = { name, level, children: {}, sampleSkus: [], productCount: 0 };
  }
  return parent.children[name];
}

function addPathToTree(tree, pathParts, sku = null) {
  if (!pathParts.length) return;
  let node = tree;
  for (let i = 0; i < pathParts.length; i++) {
    node = ensureChild(node, pathParts[i], i + 1);
    if (sku && node.sampleSkus.length < 8 && !node.sampleSkus.includes(sku)) {
      node.sampleSkus.push(sku);
    }
  }
  if (sku) node.productCount += 1;
}

function treeToArray(node) {
  return Object.values(node.children)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      name: c.name,
      level: c.level,
      productCount: c.productCount || undefined,
      sampleSkus: c.sampleSkus.length ? c.sampleSkus : undefined,
      children: treeToArray(c),
    }))
    .map((c) => {
      if (!c.productCount) delete c.productCount;
      if (!c.sampleSkus) delete c.sampleSkus;
      if (!c.children.length) delete c.children;
      return c;
    });
}

function sheetToRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
}

function parseProductSheet(sheetName, ws) {
  const raw = sheetToRows(ws);
  const headers = (raw[0] || []).map(norm);
  const dataRows = raw.slice(1).filter((r) => r.some((c) => norm(c)));

  const pathCol = headers.findIndex((h) => /^target path$/i.test(h));
  const skuCol = headers.findIndex((h) => /^sku$/i.test(h));
  const nameCol = headers.findIndex((h) => /^product name$/i.test(h));
  const statusCol = headers.findIndex((h) => /^status$/i.test(h));

  const paths = new Set();
  const skus = [];
  const products = [];

  for (const row of dataRows) {
    const targetPath = norm(row[pathCol]);
    const sku = norm(row[skuCol]);
    const productName = norm(row[nameCol]);
    const status = statusCol >= 0 ? norm(row[statusCol]) : '';

    if (targetPath) paths.add(targetPath);
    if (sku) skus.push(sku);

    products.push({
      sku: sku || undefined,
      productName: productName || undefined,
      targetPath: targetPath || undefined,
      status: status || undefined,
    });
  }

  return {
    sheetName,
    rowCount: raw.length,
    dataRowCount: dataRows.length,
    headers,
    pathColumn: pathCol >= 0 ? headers[pathCol] : null,
    skuColumn: skuCol >= 0 ? headers[skuCol] : null,
    uniquePathCount: paths.size,
    uniquePaths: [...paths].sort(),
    allSkus: [...new Set(skus)].sort(),
    sampleSkus: [...new Set(skus)].slice(0, 10),
    products,
  };
}

function parseTaxonomyChangesSheet(sheetName, ws) {
  const raw = sheetToRows(ws);
  const headers = (raw[0] || []).map(norm);
  const dataRows = raw.slice(1).filter((r) => r.some((c) => norm(c)));

  const reportCol = headers.findIndex((h) => /^report type$/i.test(h));
  const pathCol = headers.findIndex((h) => /^path$/i.test(h));
  const depthCol = headers.findIndex((h) => /^depth$/i.test(h));
  const approvedCol = headers.findIndex((h) => /^approved product count$/i.test(h));
  const currentCol = headers.findIndex((h) => /^current product count$/i.test(h));
  const notesCol = headers.findIndex((h) => /^notes$/i.test(h));

  const entries = [];
  const paths = new Set();

  for (const row of dataRows) {
    const p = norm(row[pathCol]);
    if (p) paths.add(p);
    entries.push({
      reportType: reportCol >= 0 ? norm(row[reportCol]) : undefined,
      path: p || undefined,
      depth: depthCol >= 0 ? Number(row[depthCol]) || undefined : undefined,
      approvedProductCount: approvedCol >= 0 ? Number(row[approvedCol]) || 0 : undefined,
      currentProductCount: currentCol >= 0 ? Number(row[currentCol]) || 0 : undefined,
      notes: notesCol >= 0 ? norm(row[notesCol]) || undefined : undefined,
    });
  }

  const toCreate = entries.filter((e) => e.reportType?.includes('create'));
  const toKeep = entries.filter((e) => e.reportType?.includes('keep'));

  return {
    sheetName,
    rowCount: raw.length,
    dataRowCount: dataRows.length,
    headers,
    uniquePathCount: paths.size,
    uniquePaths: [...paths].sort(),
    categoriesToCreate: toCreate.map((e) => e.path).sort(),
    categoriesToKeep: toKeep.map((e) => e.path).sort(),
    entries,
  };
}

function parseGenericSheet(sheetName, ws) {
  const raw = sheetToRows(ws);
  const headers = (raw[0] || []).map(norm);
  const dataRows = raw.slice(1).filter((r) => r.some((c) => norm(c)));
  return {
    sheetName,
    rowCount: raw.length,
    dataRowCount: dataRows.length,
    headers,
    rows: dataRows.map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = norm(row[i]);
      });
      return obj;
    }),
  };
}

// Build unified Textiles tree from Target Path / Path columns
const textilesTree = { name: 'Textiles', children: {} };
const allUniquePaths = new Set();
const pathSources = {};

function recordPath(fullPath, source, sku = null) {
  if (!fullPath) return;
  allUniquePaths.add(fullPath);
  if (!pathSources[fullPath]) pathSources[fullPath] = new Set();
  pathSources[fullPath].add(source);

  const parts = splitPath(fullPath);
  if (parts[0] !== 'Textiles') return;

  // Strip "Textiles" root — tree root IS Textiles
  const ribbonParts = parts.slice(1);
  addPathToTree(textilesTree, ribbonParts, sku);
}

const sheets = {};

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];

  if (sheetName === 'Ribbon Website Import' || sheetName === 'Missing SKUs') {
    sheets[sheetName] = parseProductSheet(sheetName, ws);
    for (const p of sheets[sheetName].products) {
      recordPath(p.targetPath, sheetName, p.sku);
    }
  } else if (sheetName === 'Ribbon Taxonomy Changes') {
    sheets[sheetName] = parseTaxonomyChangesSheet(sheetName, ws);
    for (const e of sheets[sheetName].entries) {
      recordPath(e.path, sheetName);
    }
  } else {
    sheets[sheetName] = parseGenericSheet(sheetName, ws);
    // Try to find path-like columns
    for (const row of sheets[sheetName].rows) {
      for (const [k, v] of Object.entries(row)) {
        if (/path/i.test(k) && v.includes('>')) recordPath(v, sheetName);
      }
    }
  }
}

// Relative paths under Textiles (without "Textiles >" prefix)
const relativePaths = [...allUniquePaths]
  .map((p) => {
    const parts = splitPath(p);
    if (parts[0] === 'Textiles') return parts.slice(1).join(' > ');
    return p;
  })
  .filter(Boolean);

const relativePathSet = new Set(relativePaths);

const output = {
  meta: {
    sourceFile: FILE,
    copiedFrom: '/home/ubuntu/.cursor/projects/workspace/uploads/Ribbon_Website_Integration_17bf.xlsx',
    parsedAt: new Date().toISOString(),
  },
  sheetNames: wb.SheetNames,
  rowCountPerSheet: Object.fromEntries(
    wb.SheetNames.map((n) => [n, sheets[n].rowCount])
  ),
  dataRowCountPerSheet: Object.fromEntries(
    wb.SheetNames.map((n) => [n, sheets[n].dataRowCount])
  ),
  columnHeadersPerSheet: Object.fromEntries(
    wb.SheetNames.map((n) => [n, sheets[n].headers])
  ),
  textilesRibbonTaxonomy: {
    description: 'Hierarchy under Textiles for ribbon products (paths from Target Path / Path columns)',
    root: 'Textiles',
    uniqueFullPathCount: allUniquePaths.size,
    uniqueRelativePathCount: relativePathSet.size,
    allUniqueFullPaths: [...allUniquePaths].sort(),
    allUniqueRelativePaths: [...relativePathSet].sort(),
    hierarchy: treeToArray(textilesTree),
  },
  sheets,
};

fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
