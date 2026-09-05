import { resolvePathLabels } from '../components/CategorySidebar';
import { applyPathFilter, fetchAdminProductsPage, setLiveTaxonomyTree } from './products';

const STATUS_LABELS = {
  live: 'Live',
  archived: 'Archived',
  recycle: 'Recycle bin',
};

const MAX_PATH_LEVELS = 5;

function firstImageUrl(url) {
  return String(url || '').split(',')[0].trim();
}

function productToCatalogRow(p, tree, status) {
  const pathIds = Array.isArray(p.categoryPath) ? p.categoryPath : [];
  const pathLabels = resolvePathLabels(tree, pathIds);

  const dbCategory = p.categoryLabel || '';
  const dbSub1 = p.subcategoryLabels?.[0] || '';
  const dbSub2 = p.subcategoryLabels?.[1] || '';
  const dbSub3 = p.subcategoryLabels?.[2] || '';
  const dbSub4 = p.subcategoryLabels?.[3] || '';
  const dbPath = [dbCategory, dbSub1, dbSub2, dbSub3, dbSub4].filter(Boolean).join(' > ');

  const taxLabels = pathLabels.length
    ? pathLabels
    : [dbCategory, dbSub1, dbSub2, dbSub3, dbSub4].filter(Boolean);

  const row = {
    Status: STATUS_LABELS[status] || status,
    'Website SKU': p.sku || p.websiteSku || '',
    Barcode: p.barcode || p.code || '',
    'Product name': p.name || p.title || '',
    // Database-assigned categories (source of truth in website_stock)
    'Category (DB)': dbCategory,
    'Subcategory one (DB)': dbSub1,
    'Subcategory two (DB)': dbSub2,
    'Subcategory three (DB)': dbSub3,
    'Subcategory four (DB)': dbSub4,
    'Category path (DB)': dbPath,
    // Taxonomy-resolved path
    'Main category ID': pathIds[0] || p.category || '',
    'Main category (taxonomy)': taxLabels[0] || '',
    'Subcategory 1 (taxonomy)': taxLabels[1] || '',
    'Subcategory 2 (taxonomy)': taxLabels[2] || '',
    'Subcategory 3 (taxonomy)': taxLabels[3] || '',
    'Subcategory 4 (taxonomy)': taxLabels[4] || '',
    'Category path (taxonomy)': taxLabels.join(' > '),
    'Category path IDs': pathIds.join(' / '),
    'Price (incl. VAT)': p.price ?? '',
    'Sell price': p.sellPrice ?? '',
    'Stock on hand': p.stockOnHand ?? p.stockQty ?? '',
    'Available stock': p.availableStock ?? '',
    'Units of issue': p.unitsOfIssue || '',
    'Pack description': p.packDescription || '',
    Description: p.description || p.originalDescription || '',
    'Image URL 1': firstImageUrl(p.image || p.images?.[0]),
    'Image URL 2': firstImageUrl(p.secondaryImage || p.images?.[1]),
    'Image URL 3': firstImageUrl(p.imageThree || p.images?.[2]),
    'Image URL 4': firstImageUrl(p.imageFour || p.images?.[3]),
    'All image URLs': [p.image, p.secondaryImage, p.imageThree, p.imageFour, ...(p.images || [])]
      .map(firstImageUrl)
      .filter((url, i, arr) => url && arr.indexOf(url) === i)
      .join(', '),
    'Keep live when OOS': p.keepLiveWhenOos ? 'Yes' : 'No',
    'Still live': p.stillLive ? 'Yes' : 'No',
    'New arrival': p.isNew ? 'Yes' : 'No',
    'In stock': p.inStock === false ? 'No' : 'Yes',
    'Archived by': p.archivedBy || '',
    'Created at': p.createdAt || '',
    'Updated at': p.updatedAt || '',
  };

  return row;
}

function sortCatalogRows(rows) {
  return [...rows].sort((a, b) => {
    const c = (a['Category path (DB)'] || a['Category path (taxonomy)'] || '')
      .localeCompare(b['Category path (DB)'] || b['Category path (taxonomy)'] || '');
    if (c) return c;
    return (a['Product name'] || '').localeCompare(b['Product name'] || '');
  });
}

async function fetchAllCatalogProducts(status) {
  const pageSize = 200;
  const rows = [];
  let page = 1;

  while (true) {
    const qs = new URLSearchParams({
      status,
      page: String(page),
      pageSize: String(pageSize),
      sort: 'title',
    });
    const res = await fetch(`/api/catalog?${qs}`, { credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load products');
    rows.push(...(json.rows || []));
    if (!json.hasMore) break;
    page += 1;
  }

  return rows;
}

async function fetchProductsForStatus(status) {
  if (status === 'archived') {
    const { rows } = await fetchAdminProductsPage({
      page: 1,
      pageSize: 999999,
      archived: true,
      categoryFilter: 'all',
    });
    return rows;
  }
  if (status === 'recycle') {
    const { rows } = await fetchAdminProductsPage({
      page: 1,
      pageSize: 999999,
      recycled: true,
      categoryFilter: 'all',
    });
    return rows;
  }
  const { rows } = await fetchAdminProductsPage({
    page: 1,
    pageSize: 999999,
    categoryFilter: 'all',
  });
  return rows;
}

function walkCategoryTree(nodes, ancestors = [], rows = []) {
  for (const node of nodes || []) {
    const path = [...ancestors, node];
    const labels = path.map((n) => n.label);
    const ids = path.map((n) => n.id);
    const row = {
      'Full path': labels.join(' > '),
      Depth: path.length,
      'Is leaf': node.children?.length ? 'No' : 'Yes',
    };
    for (let i = 0; i < MAX_PATH_LEVELS; i += 1) {
      row[`Level ${i + 1}`] = labels[i] || '';
      row[`Level ${i + 1} ID`] = ids[i] || '';
    }
    rows.push(row);
    if (node.children?.length) walkCategoryTree(node.children, path, rows);
  }
  return rows;
}

function buildCategoryTreeSheet(tree) {
  return walkCategoryTree(tree);
}

async function resolveProductsForExport(products, selectedIds, status) {
  const byId = new Map((products || []).map((p) => [p.id || p.sku, p]));
  const resolved = [];
  const missing = [];

  for (const id of selectedIds) {
    const row = byId.get(id);
    if (row) resolved.push(row);
    else missing.push(id);
  }

  if (!missing.length) return resolved;

  const catalogRows = await fetchAllCatalogProducts(status);
  const catalogById = new Map(catalogRows.map((r) => [r.id || r.sku, r]));
  for (const id of missing) {
    const row = catalogById.get(id);
    if (row) resolved.push(row);
  }
  return resolved;
}

/**
 * Export only the selected products with full catalogue columns
 * (code, price, description, image URLs, categories, stock, etc.).
 */
export async function exportSelectedProductsXlsx(products, {
  status = 'live',
  taxonomyTree = [],
  selectedIds = [],
} = {}) {
  const XLSX = await import('xlsx');
  const tree = Array.isArray(taxonomyTree) ? taxonomyTree : [];
  const ids = [...new Set((selectedIds.length ? selectedIds : (products || []).map((p) => p.id || p.sku))
    .map((id) => String(id || '').trim())
    .filter(Boolean))];

  if (!ids.length) throw new Error('No products selected');

  const resolved = await resolveProductsForExport(products, ids, status);
  if (!resolved.length) throw new Error('Could not load selected products for export');

  const sheetRows = sortCatalogRows(resolved.map((p) => productToCatalogRow(p, tree, status)));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, `Selected (${sheetRows.length})`.slice(0, 31));

  const stamp = new Date().toISOString().slice(0, 10);
  const statusSlug = String(status).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  XLSX.writeFile(wb, `proto-selected-${statusSlug}-${sheetRows.length}-${stamp}.xlsx`);
  return sheetRows.length;
}

/** Export catalogue with full DB + taxonomy categories and all product fields. */
export async function exportProductsCatalogXlsx({ status = 'live', taxonomyTree = [], categoryPath = [] } = {}) {
  const XLSX = await import('xlsx');
  const tree = Array.isArray(taxonomyTree) ? taxonomyTree : [];
  setLiveTaxonomyTree(tree);

  let products = await fetchProductsForStatus(status);
  // Scope to the currently-selected category using the SAME matcher the
  // Product Manager grid uses. This used to be an inline prefix comparison
  // over product.categoryPath, which disagreed with the grid in two ways:
  // it dropped products recorded only against the main category when a
  // subcategory was selected, and it compared raw ids, so rows whose path
  // holds labels (as several loader paths produce) never matched at all.
  // Both showed up as an export missing products that were plainly on screen.
  // setLiveTaxonomyTree(tree) above means this resolves through the taxonomy.
  products = applyPathFilter(products, Array.isArray(categoryPath) ? categoryPath : []);
  const sheetRows = sortCatalogRows(products.map((p) => productToCatalogRow(p, tree, status)));

  const wb = XLSX.utils.book_new();
  const mainSheet = STATUS_LABELS[status] || 'Products';
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, mainSheet.slice(0, 31));

  const treeRows = buildCategoryTreeSheet(tree);
  if (treeRows.length) {
    const treeWs = XLSX.utils.json_to_sheet(treeRows);
    XLSX.utils.book_append_sheet(wb, treeWs, 'Category tree');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const statusSlug = String(status).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  XLSX.writeFile(wb, `proto-products-${statusSlug}-${stamp}.xlsx`);
  return sheetRows.length;
}

/** Export live + archived + recycle in one workbook (all products, all data). */
export async function exportAllProductsCatalogXlsx({ taxonomyTree = [] } = {}) {
  const XLSX = await import('xlsx');
  const tree = Array.isArray(taxonomyTree) ? taxonomyTree : [];
  setLiveTaxonomyTree(tree);

  const statuses = ['live', 'archived', 'recycle'];
  const allRows = [];

  for (const status of statuses) {
    const products = await fetchProductsForStatus(status);
    allRows.push(...products.map((p) => productToCatalogRow(p, tree, status)));
  }

  const sheetRows = sortCatalogRows(allRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'All products');

  const treeRows = buildCategoryTreeSheet(tree);
  if (treeRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(treeRows), 'Category tree');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `proto-products-all-${stamp}.xlsx`);
  return sheetRows.length;
}
