export const SOURCE_DEFINITIONS = Object.freeze({
  events: { table: 'shopping_events', columns: 'event_id,event_type,customer_id,session_id,created_at,source,product_id,search_id,search_term,results_count,main_results_count,instore_results_count,position,tip_stage,quantity,order_id,metadata,environment,is_internal', timestamp: 'created_at', primaryKey: 'event_id' },
  visits: { table: 'customer_visits', columns: 'id,customer_id,session_id,started_at,last_seen_at', timestamp: 'started_at' },
  searches: { table: 'search_analytics', columns: 'id,customer_id,session_id,search_term,normalized_search_term,results_found,clicked_product_sku,added_to_cart,order_created,created_at', timestamp: 'created_at' },
  journeys: { table: 'customer_journey_events', columns: 'id,customer_id,session_id,event_type,journey,step,outcome,metadata,created_at', timestamp: 'created_at' },
  legacyEvents: { table: 'analytics_events', columns: 'id,customer_id,event_type,entity_id,entity_label,created_at', timestamp: 'created_at' },
  orders: { table: 'orders', columns: 'id,customer_id,order_number,status,total_ex_vat,items,created_at', timestamp: 'created_at' },
  customers: { table: 'customers', columns: 'id,name,contact_name,business_name,email,role,product_categories,sales_channels,supply_needs', timestamp: null },
  products: { table: 'products', columns: 'id,code,name,category_path,created_at,is_new,is_archived,stock_on_hand', timestamp: null },
});

export function parseAnalyticsScope(query = {}, now = new Date()) {
  const days = Number(query.days || 30);
  if (![7, 30, 90].includes(days)) throw new TypeError('Choose a 7, 30 or 90 day range.');
  const source = query.source || 'all';
  if (!['all', 'main', 'instore'].includes(source)) throw new TypeError('Invalid product source.');
  if (query.includeInternal !== undefined && !['true', 'false'].includes(String(query.includeInternal))) {
    throw new TypeError('Invalid internal activity filter.');
  }
  const customerId = query.customerId;
  if (customerId !== undefined && (typeof customerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId))) throw new TypeError('Invalid customer identifier.');
  const customerSearch = query.customerSearch;
  if (customerSearch !== undefined && (typeof customerSearch !== 'string' || customerSearch.trim().length < 3 || customerSearch.trim().length > 80)) throw new TypeError('Use 3 to 80 characters to find a customer.');
  if (customerId && customerSearch) throw new TypeError('Choose customer details or customer lookup.');
  const { evidenceType, evidenceValue, evidenceSource } = query;
  if (evidenceType !== undefined || evidenceValue !== undefined || evidenceSource !== undefined) {
    if (!['term','product','department'].includes(evidenceType) || typeof evidenceValue !== 'string' || !evidenceValue.trim() || evidenceValue.length > ({term:200,product:128,department:160}[evidenceType] || 0)) throw new TypeError('Invalid analytics evidence request.');
    if (customerId || customerSearch) throw new TypeError('Choose evidence, customer details or customer lookup.');
    if (evidenceSource !== undefined && (evidenceType !== 'product' || !['main','instore','unknown'].includes(evidenceSource))) throw new TypeError('Invalid evidence source.');
    if (evidenceSource && source !== 'all' && evidenceSource !== source) throw new TypeError('Evidence source must match the catalogue filter.');
  }
  return { days, source, includeInternal: String(query.includeInternal) === 'true',
    since: new Date(now.getTime() - days * 86400000).toISOString(), until: now.toISOString(), ...(customerId ? { customerId } : {}), ...(customerSearch ? { customerSearch: customerSearch.trim() } : {}), ...(evidenceType ? { evidenceType, evidenceValue: evidenceValue.trim(), ...(evidenceSource ? { evidenceSource } : {}) } : {}) };
}

// A stable ordering and explicit bounds prevent Supabase's default row cap
// from silently making a busy period look quiet. Partial reads stay partial.
export async function readAnalyticsSource(client, definition, scope, { pageSize = 1000, maxRows = 50000 } = {}) {
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    let query = client.from(definition.table).select(definition.columns)
      .order(definition.timestamp || definition.primaryKey || 'id', { ascending: true });
    if (scope.customerId && definition.table !== 'products') query = query.eq(definition.table === 'customers' ? 'id' : 'customer_id', scope.customerId);
    if (definition.table === 'shopping_events' && scope.evidenceType === 'product') {
      query = query.eq('product_id', scope.evidenceValue);
      if (scope.evidenceSource && scope.evidenceSource !== 'unknown') query = query.eq('source', scope.evidenceSource);
    }
    if (definition.timestamp) {
      query = query.gte(definition.timestamp, scope.since).lt(definition.timestamp, scope.until);
      query = query.order(definition.primaryKey || 'id', { ascending: true });
    }
    const { data, error } = await query.range(offset, Math.min(offset + pageSize, maxRows) - 1);
    if (error) {
      const missing = ['42P01', 'PGRST205'].includes(error.code);
      return { rows: [], status: { available: false, error: missing ? 'not_installed' : 'read_failed',
        truncated: false, table: definition.table, recordedRows: 0 } };
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, status: { available: true, error: null,
      truncated: false, table: definition.table, recordedRows: rows.length } };
  }
  return { rows, status: { available: true, error: 'row_limit', truncated: true,
    table: definition.table, recordedRows: rows.length } };
}

/** Adjacent equal-duration window; end remains exclusive. */
export function previousAnalyticsScope(scope) {
  const since = Date.parse(scope.since); const until = Date.parse(scope.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) throw new RangeError('Invalid comparison window');
  return { ...scope, since: new Date(since - (until - since)).toISOString(), until: scope.since };
}
