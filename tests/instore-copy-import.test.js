import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/nutstore-process.js';
import { getStockClient } from '../api/_stock-client.js';
import { fetchStmastRow } from '../api/_sql-stmast.js';
import { customerPriceFromPositill } from '../lib/catalogue-price.mjs';
vi.mock('../api/_stock-client.js', () => ({ getStockClient: vi.fn() }));
vi.mock('../api/_admin-auth.js', () => ({ requireOwner: vi.fn().mockResolvedValue(true), verifyAdminUser: vi.fn().mockResolvedValue({ email: 'owner@test.invalid' }) }));
vi.mock('../api/_sql-stmast.js', () => ({ fetchStmastRow: vi.fn(), sqlRowToPreview: (raw) => ({ title: raw.DESCR, price: raw.PRICE_A, units_of_issue: raw.UNITS, onhand: raw.ONHAND, available: raw.ONHAND - raw.BOOKED }) }));
const live = { CODE: '78446', DESCR: 'CROCHET TOTOE BAG KIT', PRICE_A: 95.22, UNITS: 'EACH', ONHAND: 14, BOOKED: 2 };
const copy = { title: 'crochet tote bag kit', description: 'make your own crochet bag' };
let writes, upload, db;
const item = (extra = {}) => ({ code: '78446', filename: '78446.jpg', imageBase64: 'aW1hZ2U=', contentType: 'image/jpeg', category: 'Arts & Crafts', categoryPath: ['Arts & Crafts', 'Crafts', 'Embroidery'], websiteCopy: copy, ...extra });
const res = () => ({ statusCode: 0, status(code) { this.statusCode = code; return this; }, setHeader: vi.fn(), json: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('INSTORE_LANDED_IMPORT_MODE', 'production-enabled'); fetchStmastRow.mockResolvedValue(live); writes = []; upload = vi.fn().mockResolvedValue({ error: null });
  db = { storage: { createBucket: vi.fn().mockResolvedValue({}), from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'https://example.invalid/photo.jpg' } }), remove: vi.fn().mockResolvedValue({}) }) }, from(table) {
    const q = { select: () => q, eq: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: null }), insert: async (value) => { writes.push({ table, value }); return { error: null }; } }; return q;
  } }; getStockClient.mockReturnValue(db);
});
afterEach(() => vi.unstubAllEnvs());
async function run(selected = item()) { const response = res(); await handler({ method: 'POST', body: { action: 'instore_live', items: [selected] } }, response); return response; }
describe('reviewed website wording at the live import boundary (mock database)', () => {
  it('saves capitals but takes exact identity, rounded price, selling unit and stock only from Positill', async () => {
    const response = await run(item({ price: 1, available_stock: 999, title: 'UNTRUSTED' }));
    expect(response.statusCode).toBe(200);
    expect(writes.find((w) => w.table === 'extended_range_items').value).toMatchObject({ sku: '78446', barcode: '78446', title: 'CROCHET TOTE BAG KIT', original_description: 'MAKE YOUR OWN CROCHET BAG', price: customerPriceFromPositill(live.PRICE_A), available_stock: 12 });
    expect(writes[0]).toMatchObject({ table: 'product_publish_audit', value: { old_values: { positillTitle: live.DESCR }, publish_mode: 'instore_copy_intent' } });
    expect(fetchStmastRow).toHaveBeenCalledWith('78446'); expect(upload).toHaveBeenCalledOnce();
  });
  it('uses source copy unchanged when no website edit was supplied', async () => {
    await run(item({ websiteCopy: undefined })); expect(writes.find((w) => w.table === 'extended_range_items').value.title).toBe(live.DESCR);
  });
  it('cannot use a renamed website description to bypass gift-bag destination checks', async () => {
    fetchStmastRow.mockResolvedValue({ ...live, DESCR: 'GIFT BAG FLOWERS' }); const response = await run();
    expect(response.statusCode).toBe(207); expect(response.json.mock.calls[0][0].results[0].error).toContain('Choose Packaging'); expect(upload).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it('cannot bypass live selling-unit or stock safeguards with edited wording', async () => {
    for (const row of [{ ...live, UNITS: '' }, { ...live, ONHAND: 2 }]) {
      fetchStmastRow.mockResolvedValue(row); const response = await run(); expect(response.statusCode).toBe(207); expect(upload).not.toHaveBeenCalled();
    } expect(writes).toEqual([]);
  });
  it('blocks invalid wording before uploading an image or creating a product', async () => {
    const response = await run(item({ websiteCopy: { title: '', description: 'OK' } })); expect(response.statusCode).toBe(207); expect(upload).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it('stops an edited import before storage/insert if required copy evidence cannot be saved', async () => {
    const original = db.from; db.from = (table) => table === 'product_publish_audit' ? { insert: async () => ({ error: { message: 'offline' } }) } : original(table);
    const response = await run(); expect(response.statusCode).toBe(207); expect(upload).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
});
