import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const { requireOwner, verifyAdminUser, getStockClient, fetchStmastRow } = vi.hoisted(() => ({ requireOwner: vi.fn(), verifyAdminUser: vi.fn(async () => ({ email: 'owner@example.test' })), getStockClient: vi.fn(), fetchStmastRow: vi.fn() }));
vi.mock('../api/_admin-auth.js', () => ({ requireOwner, verifyAdminUser }));
vi.mock('../api/_stock-client.js', () => ({ getStockClient }));
vi.mock('../api/_sql-stmast.js', () => ({ fetchStmastRow, sqlRowToPreview: (r) => ({ code: r.CODE, title: r.DESCR, price: r.PRICE_A, onhand: r.ONHAND, available: r.ONHAND - r.BOOKED }) }));
const { default: handler } = await import('../api/instore-admin.js');
function response() { return { statusCode: 200, body: null, setHeader() {}, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; }, end() { return this; } }; }
function request(body) { return { method: 'POST', body, query: {}, headers: {} }; }
beforeEach(() => {
  vi.clearAllMocks();
  requireOwner.mockResolvedValue(true);
  vi.stubEnv('INSTORE_ADMIN_PUBLISH_ENABLED', 'false');
  vi.stubEnv('INSTORE_ADMIN_PREVIEW_ONLY', 'true');
  vi.stubEnv('INSTORE_ADMIN_TEST_WRITES', 'true');
  vi.stubEnv('INSTORE_ADMIN_TEST_PROJECT_REF', 'zbxvcdkcarrgtmdhwmdm');
  vi.stubEnv('STOCK_SUPABASE_URL', 'https://zbxvcdkcarrgtmdhwmdm.supabase.co');
  vi.stubEnv('STOCK_SUPABASE_KEY', 'test-only-server-key');
  vi.stubEnv('VERCEL_ENV', 'preview');
});

function stockMock(item = null, duplicate = null, slot = null) {
  const upload = vi.fn(async () => ({ error: null }));
  const imageInsert = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn(async (_name, args) => ({ data: { sku: args.p_sku, version: 1, ...args.p_patch }, error: null }));
  const client = { rpc, storage: { from: () => ({ upload }) }, from: vi.fn((table) => {
    const chain = {
      select: () => chain, eq: () => chain, or: () => chain,
      insert: imageInsert,
      maybeSingle: async () => ({ data: table === 'instore_admin_items' ? item : table === 'instore_admin_item_images' ? slot : table === 'products' ? { units_of_issue: 'PACK 5' } : duplicate, error: null }),
    };
    return chain;
  }) };
  getStockClient.mockReturnValue(client);
  fetchStmastRow.mockResolvedValue({ CODE: 'ABC123', DESCR: 'METAL CHARMS', PRICE_A: 25.65, ONHAND: 0, BOOKED: 0 });
  return { client, upload, rpc, imageInsert };
}
const stageBody = { action: 'stage', batchId: '123e4567-e89b-12d3-a456-426614174000', filename: 'ABC123.jpg', contentType: 'image/jpeg', imageBase64: Buffer.from([255,216,255,217]).toString('base64') };
const stageDigest = createHash('sha256').update(Buffer.from([255,216,255,217])).digest('hex').slice(0, 20);
describe('Instore admin API behavior', () => {
  it('stages an exact code privately with real zero stock and inclusive price', async () => {
    const { rpc, upload } = stockMock(); const res = response();
    await handler(request(stageBody), res);
    expect(res.statusCode).toBe(201); expect(upload).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('instore_admin_transition', expect.objectContaining({ p_sku: 'ABC123', p_action: 'stage', p_patch: expect.objectContaining({ status: 'archived', recorded_stock: 0, confirmed_qty: null, price_incl_vat: 29.5, units_of_issue: 'PACK 5' }) }));
  });
  it('does not upload or overwrite an existing SKU slot on an exact retry', async () => {
    const path = `${stageBody.batchId}/ABC123/s1-${stageDigest}.jpg`;
    const { rpc, upload, imageInsert } = stockMock({ sku: 'ABC123', version: 3 }, null, { image_path: path, content_digest: stageDigest }); const res = response();
    await handler(request(stageBody), res);
    expect(res.statusCode).toBe(200); expect(res.body.idempotent).toBe(true);
    expect(rpc).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(imageInsert).not.toHaveBeenCalled();
  });
  it('stores a numbered image as an additional slot without replacing the primary item image', async () => {
    const { rpc, imageInsert } = stockMock({ sku: 'ABC123', version: 3 }); const res = response();
    await handler(request({ ...stageBody, filename: 'ABC123.2.jpg' }), res);
    expect(res.statusCode).toBe(200); expect(rpc).not.toHaveBeenCalled();
    expect(imageInsert).toHaveBeenCalledWith(expect.objectContaining({ sku: 'ABC123', image_slot: 2 }));
  });
  it('rejects an additional image before a primary item exists', async () => {
    const { upload, rpc } = stockMock(); const res = response();
    await handler(request({ ...stageBody, filename: 'ABC123.2.jpg' }), res);
    expect(res.statusCode).toBe(400); expect(upload).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects a different retry for an occupied image slot without overwriting it', async () => {
    const { upload, imageInsert } = stockMock({ sku: 'ABC123', version: 3 }, null, { image_path: 'old/path.jpg', content_digest: '00000000000000000000' }); const res = response();
    await handler(request(stageBody), res);
    expect(res.statusCode).toBe(409); expect(upload).not.toHaveBeenCalled(); expect(imageInsert).not.toHaveBeenCalled();
  });
  it('stages an existing source SKU as a private Instore review item', async () => {
    const { upload } = stockMock(null, { sku: 'ABC123' }); const res = response();
    await handler(request(stageBody), res); expect(res.statusCode).toBe(201); expect(upload).toHaveBeenCalled();
  });
  it('keeps missing exact source data in review, not ready for approval', async () => {
    const { rpc } = stockMock(); fetchStmastRow.mockResolvedValue(null); const res = response();
    await handler(request(stageBody), res);
    expect(rpc.mock.calls[0][1].p_patch.review_error).toBe('positill_code_not_found');
  });
  it.each([['TimeoutError', 'positill_lookup_timed_out'], ['Error', 'positill_connection_failed']])('distinguishes %s without leaking upstream messages', async (name, expected) => {
    const { rpc } = stockMock();
    fetchStmastRow.mockRejectedValue(Object.assign(new Error('private upstream detail'), { name }));
    await handler(request(stageBody), response());
    expect(rpc.mock.calls[0][1].p_patch.review_error).toBe(expected);
    expect(JSON.stringify(rpc.mock.calls[0][1].p_patch)).not.toContain('private upstream detail');
  });
  it('sync preserves staff confirmed quantity while recorded stock stays zero', async () => {
    const { rpc } = stockMock({ sku: 'ABC123', version: 4, availability_mode: 'stock_available', confirmed_qty: 8 }); const res = response();
    await handler(request({ action: 'sync', sku: 'ABC123', version: 4 }), res);
    expect(res.statusCode).toBe(200); expect(rpc.mock.calls[0][1].p_patch).toMatchObject({ recorded_stock: 0, confirmed_qty: 8 });
  });
  it('records a separately confirmed quantity for stock available without changing Positill stock', async () => {
    const { rpc } = stockMock({ sku: 'ABC123', version: 4, recorded_stock: 0, availability_mode: 'positill' }); const res = response();
    await handler(request({ action: 'update', sku: 'ABC123', version: 4, patch: { availability_mode: 'stock_available', confirmed_qty: 7 } }), res);
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('instore_admin_transition', expect.objectContaining({
      p_action: 'update', p_expected_version: 4,
      p_patch: { availability_mode: 'stock_available', confirmed_qty: 7 },
    }));
  });
  it.each(['archive', 'recycle', 'restore'])('uses the protected transition for %s', async (action) => {
    const { rpc } = stockMock({ sku: 'ABC123', version: 4, status: 'archived' }); const res = response();
    await handler(request({ action, sku: 'ABC123', version: 4 }), res);
    expect(res.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('instore_admin_transition', expect.objectContaining({
      p_sku: 'ABC123', p_expected_version: 4, p_action: action, p_patch: {},
    }));
  });
  it('rejects a stale version without any write', async () => {
    const { rpc } = stockMock({ sku: 'ABC123', version: 4 }); const res = response();
    await handler(request({ action: 'sync', sku: 'ABC123', version: 3 }), res);
    expect(res.statusCode).toBe(409); expect(rpc).not.toHaveBeenCalled();
  });
  it('requires a positive whole manual quantity for stock available and clears it for to order', async () => {
    const { rpc } = stockMock({ sku: 'ABC123', version: 4, availability_mode: 'stock_available', confirmed_qty: 8 });
    const invalid = response(); await handler(request({ action: 'update', sku: 'ABC123', version: 4, patch: { availability_mode: 'stock_available', confirmed_qty: 0 } }), invalid);
    expect(invalid.statusCode).toBe(400); expect(rpc).not.toHaveBeenCalled();
    const valid = response(); await handler(request({ action: 'update', sku: 'ABC123', version: 4, patch: { availability_mode: 'to_order', confirmed_qty: 8 } }), valid);
    expect(valid.statusCode).toBe(200); expect(rpc.mock.calls[0][1].p_patch).toMatchObject({ availability_mode: 'to_order', confirmed_qty: null });
  });
  it('fails closed before touching stock when unauthenticated', async () => { requireOwner.mockImplementation(async (_req, res) => { res.status(401).json({ error: 'Authentication required' }); return false; }); const res = response(); await handler(request({ action: 'stage' }), res); expect(res.statusCode).toBe(401); expect(getStockClient).not.toHaveBeenCalled(); });
  it('returns 400 for invalid image bytes', async () => { getStockClient.mockReturnValue({}); const res = response(); await handler(request({ action: 'stage', batchId: '123e4567-e89b-12d3-a456-426614174000', filename: 'ABC123.jpg', contentType: 'image/jpeg', imageBase64: Buffer.from('not-jpeg').toString('base64') }), res); expect(res.statusCode).toBe(400); expect(res.body.error).toMatch(/bytes|image/i); });
  it('keeps approval disabled by default without making a transition', async () => { const { rpc } = stockMock({ sku: 'ABC123', version: 1 }); const res = response(); await handler(request({ action: 'approve', sku: 'ABC123', version: 1 }), res); expect(res.statusCode).toBe(503); expect(rpc).not.toHaveBeenCalled(); });
});

