const WEBSITE_FIELDS = [
  'sku',
  'barcode',
  'title',
  'original_description',
  'price',
  'stock_qty',
  'available_stock',
  'category',
  'subcategory_one',
  'subcategory_two',
  'subcategory_three',
  'subcategory_four',
  'image_url_one',
].join(', ');

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function websiteProduct(row) {
  if (!row) return null;
  return {
    sku: String(row.sku || '').trim(),
    barcode: String(row.barcode || '').trim() || null,
    title: String(row.title || '').trim(),
    description: String(row.original_description || '').trim(),
    price: numberOrNull(row.price),
    stockOnHand: numberOrNull(row.stock_qty),
    availableStock: numberOrNull(row.available_stock),
    categoryPath: [
      row.category,
      row.subcategory_one,
      row.subcategory_two,
      row.subcategory_three,
      row.subcategory_four,
    ].map((part) => String(part || '').trim()).filter(Boolean),
    imageUrl: String(row.image_url_one || '').trim() || null,
  };
}

function erpProduct(row) {
  if (!row) return null;
  return {
    code: String(row.code || '').trim(),
    title: String(row.title || '').trim(),
    price: numberOrNull(row.price),
    stockOnHand: numberOrNull(row.onhand),
    booked: numberOrNull(row.booked),
    availableStock: numberOrNull(row.available),
    department: String(row.dept || '').trim() || null,
  };
}

async function exactWebsiteLookup(stockClient, code) {
  const bySku = await stockClient
    .from('website_stock')
    .select(WEBSITE_FIELDS)
    .eq('sku', code)
    .maybeSingle();
  if (bySku.error) throw bySku.error;
  if (bySku.data) return bySku.data;

  const byBarcode = await stockClient
    .from('website_stock')
    .select(WEBSITE_FIELDS)
    .eq('barcode', code)
    .maybeSingle();
  if (byBarcode.error) throw byBarcode.error;
  return byBarcode.data || null;
}

/**
 * Build one read-only product snapshot from the website catalogue and ERP.
 * ERP enrichment is deliberately optional: catalogue lookup remains useful
 * when the office bridge or its cache is temporarily unavailable.
 */
export async function buildProductIntelligence({ code, stockClient, resolveErp }) {
  const [websiteOutcome, erpOutcome] = await Promise.allSettled([
    stockClient
      ? exactWebsiteLookup(stockClient, code)
      : Promise.reject(new Error('website catalogue unavailable')),
    resolveErp(code),
  ]);

  const websiteUnavailable = websiteOutcome.status === 'rejected';
  const websiteRow = websiteUnavailable ? null : websiteOutcome.value;
  const erpUnavailable = erpOutcome.status === 'rejected';
  const erpResult = erpUnavailable ? null : erpOutcome.value;

  const dataSource = erpResult?.dataSource || null;
  const product = erpProduct(erpResult?.product);
  // If a live path was attempted but did not produce a live row, keep the
  // result explicitly degraded. The provider intentionally hides bridge
  // errors while trying cache, so this conservative flag avoids presenting an
  // uncertain live-ERP miss as authoritative.
  const degraded = websiteUnavailable
    || erpUnavailable
    || dataSource === 'stmast_cache'
    || (Boolean(erpResult?.bridgeAttempted) && dataSource !== 'erp_sql');

  return {
    schemaVersion: 'proto.product-intelligence.v1',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    code,
    website: websiteProduct(websiteRow),
    erp: product,
    sources: {
      website: websiteRow ? 'website_stock' : null,
      erp: dataSource,
    },
    status: {
      website: websiteUnavailable ? 'unavailable' : (websiteRow ? 'available' : 'not_found'),
      erp: erpUnavailable ? 'unavailable' : (product ? 'available' : 'not_found'),
      degraded,
    },
    warnings: [
      ...(websiteUnavailable ? ['website_unavailable'] : []),
      ...(erpUnavailable ? ['erp_unavailable'] : []),
      ...(dataSource === 'stmast_cache' ? ['erp_cache'] : []),
    ],
    capabilities: {
      actionsEnabled: false,
      positillWritesEnabled: false,
    },
  };
}
