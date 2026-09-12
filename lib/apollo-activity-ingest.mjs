// Pure trusted adapter. It never queries or writes a database.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['main', 'instore']);
const TYPES = new Set(['search_completed', 'product_view', 'category_view', 'cart_item_added', 'active_interval']);
const TOP = new Set(['event_id', 'session_id', 'source', 'event_type', 'occurred_at', 'search', 'product', 'category', 'cart', 'interval']);
// The database constraint accepts no event more than one day before receipt.
// Keep this boundary aligned so an accepted HTTP event is insertable.
const AGE = 86400000; const FUTURE = 5 * 60000;
function bad(message) { throw new TypeError(message); }
function uuid(value, field) { if (!UUID.test(String(value || ''))) bad(`Invalid ${field}`); return String(value); }
function date(value, field) { if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) bad(`Invalid ${field}`); const ms = Date.parse(value); if (!Number.isFinite(ms)) bad(`Invalid ${field}`); return { ms, iso: new Date(ms).toISOString() }; }
function object(value, keys, field) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.has(key))) bad(`Invalid ${field}`); }
function string(value, field) { if (typeof value !== 'string' || !value.trim() || value.length > 240) bad(`Invalid ${field}`); return value.trim(); }
function integer(value, field, max = Infinity) { if (!Number.isSafeInteger(value) || value < 0 || value > max) bad(`Invalid ${field}`); return value; }

export function ingestActivityEvent({ userId, browserEvent, receivedAt = Date.now() } = {}) {
  const customerId = uuid(userId, 'authenticated user id');
  if (!browserEvent || typeof browserEvent !== 'object' || Array.isArray(browserEvent) || Object.keys(browserEvent).some((key) => !TOP.has(key)) || Object.hasOwn(browserEvent, 'customer_id')) bad('Invalid browser event');
  const eventId = uuid(browserEvent.event_id, 'event id'); const sessionId = uuid(browserEvent.session_id, 'session id');
  if (!SOURCES.has(browserEvent.source)) bad('Invalid source'); if (!TYPES.has(browserEvent.event_type)) bad('Invalid event type');
  if (receivedAt === null || receivedAt === '' || (typeof receivedAt !== 'number' && !(receivedAt instanceof Date))) bad('Invalid receipt timestamp');
  const receipt = date(new Date(receivedAt).toISOString(), 'receipt timestamp'); const occurred = date(browserEvent.occurred_at, 'event timestamp');
  if (occurred.ms > receipt.ms + FUTURE || occurred.ms < receipt.ms - AGE) bad('Event timestamp outside receipt window');
  const payloadNames = ['search', 'product', 'category', 'cart', 'interval']; const present = payloadNames.filter((key) => Object.hasOwn(browserEvent, key));
  const expected = browserEvent.event_type === 'search_completed' ? 'search' : browserEvent.event_type === 'product_view' ? 'product' : browserEvent.event_type === 'category_view' ? 'category' : browserEvent.event_type === 'cart_item_added' ? 'cart' : 'interval';
  if (present.length !== 1 || present[0] !== expected) bad('Payload does not match event type');
  let payload;
  if (expected === 'search') { object(browserEvent.search, new Set(['original', 'normalized', 'results_count']), 'search'); payload = { original: string(browserEvent.search.original, 'search original'), normalized: string(browserEvent.search.normalized, 'search normalized'), results_count: integer(browserEvent.search.results_count, 'results count') }; }
  if (expected === 'product') { object(browserEvent.product, new Set(['kind', 'id', 'parent_id']), 'product'); if (!['parent', 'variant'].includes(browserEvent.product.kind)) bad('Invalid product kind'); if (browserEvent.product.kind === 'parent' && Object.hasOwn(browserEvent.product, 'parent_id')) bad('Parent product cannot have parent_id'); payload = { kind: browserEvent.product.kind, id: string(browserEvent.product.id, 'product id') }; if (browserEvent.product.kind === 'variant') payload.parent_id = string(browserEvent.product.parent_id, 'parent id'); }
  if (expected === 'category') { object(browserEvent.category, new Set(['id']), 'category'); payload = { id: string(browserEvent.category.id, 'category id') }; }
  if (expected === 'cart') { object(browserEvent.cart, new Set(['product_id', 'quantity']), 'cart'); payload = { product_id: string(browserEvent.cart.product_id, 'product id'), quantity: integer(browserEvent.cart.quantity, 'quantity', Infinity) }; if (payload.quantity < 1) bad('Invalid quantity'); }
  if (expected === 'interval') { object(browserEvent.interval, new Set(['start_at', 'end_at', 'seconds']), 'interval'); const start = date(browserEvent.interval.start_at, 'interval start'); const end = date(browserEvent.interval.end_at, 'interval end'); const seconds = integer(browserEvent.interval.seconds, 'interval', 60); if (end.ms <= start.ms || end.ms - start.ms > 60000 || seconds !== Math.floor((end.ms - start.ms) / 1000)) bad('Invalid active interval'); if (end.ms > occurred.ms + FUTURE) bad('Interval outside event time'); payload = { start_at: start.iso, end_at: end.iso, seconds }; }
  return Object.freeze({ event_id: eventId, customer_id: customerId, session_id: sessionId, source: browserEvent.source, event_type: browserEvent.event_type, occurred_at: occurred.iso, received_at: receipt.iso, payload });
}
