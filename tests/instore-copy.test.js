import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeInstoreCopy } from '../lib/instore-copy.mjs';
import { exactInstoreCopySku, saveInstoreCopy } from '../api/_instore-copy.js';
import { loadInstoreCopy, updateInstoreCopy } from '../src/lib/instoreCopyApi.js';
import handler from '../api/instore-copy.js';
import { getStockClient } from '../api/_stock-client.js';
import { requireOwner } from '../api/_admin-auth.js';
import { auditOutcomeFromRow } from '../api/_product-loader-audit.js';

vi.mock('../api/_stock-client.js', () => ({ getStockClient: vi.fn() }));
vi.mock('../api/_admin-auth.js', () => ({ requireOwner: vi.fn(), verifyAdminUser: vi.fn().mockResolvedValue({ email: 'owner@test.invalid' }) }));
const initial = { sku: '78446', title: 'OLD NAME', original_description: 'OLD DESCRIPTION', price: 109.5, available_stock: 12, image_url: 'https://example.invalid/image.jpg', updated_at: '2026-10-03T10:00:00.000Z' };
const draft = { title: 'crochet tote bag kit', description: 'includes yarn and crochet hook' };

function database({ missing = false, race = false, auditFailAt = 0, updateFailure = false, cacheFailure = false } = {}) {
  const writes = []; let auditCount = 0; let row = missing ? null : { ...initial };
  return { writes, get row() { return row; }, from(table) {
    let patch; const filters = [];
    const query = {
      select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
      update(value) { patch = value; return query; },
      async insert(value) { writes.push({ table, type: 'insert', value }); auditCount += 1; return { error: auditCount === auditFailAt ? { message: 'audit offline' } : null }; },
      async maybeSingle() {
        if (table === 'instore_catalogue_state') { writes.push({ table, value: patch, filters }); return { data: cacheFailure ? null : { id: true }, error: cacheFailure ? { message: 'cache offline' } : null }; }
        if (!patch) return { data: row, error: null };
        writes.push({ table, value: patch, filters });
        if (updateFailure) return { error: { message: 'write offline' } };
        if (race || !row || filters.some(([key, value]) => row[key] !== value)) return { data: null, error: null };
        row = { ...row, ...patch }; return { data: row, error: null };
      },
    };
    return query;
  } };
}
const save = (db, extra = {}) => saveInstoreCopy(db, { sku: initial.sku, expectedUpdatedAt: initial.updated_at, copy: draft, actor: 'owner@test.invalid', ...extra });

beforeEach(() => { vi.clearAllMocks(); requireOwner.mockResolvedValue(true); vi.stubEnv('INSTORE_LANDED_IMPORT_MODE', 'production-enabled'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Instore website wording validation', () => {
  it('normalises both fields, preserves description paragraphs and excludes extra fields', () => {
    expect(normalizeInstoreCopy({ title: '  crochet\n tote bag  ', description: '  Yarn\r\nHook  ', price: 1 })).toEqual({ title: 'CROCHET TOTE BAG', description: 'YARN\nHOOK' });
  });
  it.each([null, [], { title: {}, description: 'OK' }, { title: '', description: 'OK' }, { title: 'OK', description: ' ' }, { title: '<b>BAD</b>', description: 'OK' }, { title: 'OK', description: 'x\0y' }, { title: 'ß'.repeat(151), description: 'OK' }, { title: 'OK', description: 'x'.repeat(2001) }])('rejects invalid or over-limit wording: %j', (copy) => { expect(() => normalizeInstoreCopy(copy)).toThrow(); });
  it('accepts only one exact code, never fuzzy or multiple-code input', () => {
    expect(exactInstoreCopySku(' 78446 ')).toBe('78446');
    for (const value of [null, 78446, ['78446'], '78446,78445', '78446%']) expect(exactInstoreCopySku(value)).toBe('');
  });
});
describe('Instore wording persistence', () => {
  it('never labels an intent-only audit as a successful publication', () => {
    expect(auditOutcomeFromRow({ action: 'update', publish_mode: 'instore_copy_intent', new_values: { outcome: 'pending' } })).toBe('pending');
    expect(auditOutcomeFromRow({ action: 'update', publish_mode: 'instore_copy_saved', new_values: { outcome: 'published' } })).toBe('published');
    expect(auditOutcomeFromRow({ action: 'create', new_values: {} })).toBe('published');
  });
  it('writes only copy and its version, retains image/price/stock and audits the before/after', async () => {
    const db = database(); const result = await save(db);
    expect(result).toMatchObject({ status: 200, ok: true, item: { title: 'CROCHET TOTE BAG KIT', original_description: 'INCLUDES YARN AND CROCHET HOOK', price: initial.price, available_stock: 12, image_url: initial.image_url } });
    const write = db.writes.find((w) => w.table === 'extended_range_items');
    expect(Object.keys(write.value).sort()).toEqual(['original_description', 'title', 'updated_at']);
    expect(write.filters).toEqual([['sku', '78446'], ['updated_at', initial.updated_at]]);
    expect(db.writes[0].value).toMatchObject({ publish_mode: 'instore_copy_intent', old_values: { title: 'OLD NAME' }, new_values: { outcome: 'pending' } });
    expect(db.writes.find((w) => w.table === 'instore_catalogue_state')).toMatchObject({ value: { refreshed_at: null }, filters: [['id', true]] });
  });
  it('does not create an absent item or overwrite a changed version', async () => {
    for (const [db, extra, status] of [[database({ missing: true }), {}, 404], [database(), { expectedUpdatedAt: '2026-10-02T00:00:00Z' }, 409]]) {
      expect((await save(db, extra)).status).toBe(status); expect(db.writes).toEqual([]);
    }
    const db = database({ race: true }); expect((await save(db)).status).toBe(409); expect(db.row).toEqual(initial);
  });
  it('stops before the copy mutation when intent audit fails', async () => {
    const db = database({ auditFailAt: 1 }); await expect(save(db)).rejects.toThrow('Nothing was saved');
    expect(db.row).toEqual(initial); expect(db.writes).toHaveLength(1);
  });
  it('reports unconfirmed primary writes as errors, not success', async () => {
    const db = database({ updateFailure: true }); await expect(save(db)).rejects.toMatchObject({ message: 'write offline' }); expect(db.row).toEqual(initial);
  });
  it('acknowledges a successful save with warnings if audit completion or refresh fails', async () => {
    const db = database({ auditFailAt: 2, cacheFailure: true }); const result = await save(db);
    expect(result.ok).toBe(true); expect(result.warning).toContain('completion audit'); expect(result.warning).toContain('storefront refresh');
  });
  it('does not write again when wording already matches', async () => {
    const db = database(); const result = await save(db, { copy: { title: initial.title, description: initial.original_description } });
    expect(result.unchanged).toBe(true); expect(db.writes).toEqual([]);
  });
});
function response() { return { statusCode: 200, setHeader: vi.fn(), status(code) { this.statusCode = code; return this; }, json: vi.fn(), end: vi.fn() }; }
describe('owner-only exact-SKU API', () => {
  it('refuses unauthorized calls before creating a stock client', async () => {
    requireOwner.mockResolvedValue(false); await handler({ method: 'POST', body: { sku: '78446' } }, response()); expect(getStockClient).not.toHaveBeenCalled();
  });
  it('fails closed in previews, even when VERCEL_ENV says production', async () => {
    vi.stubEnv('INSTORE_LANDED_IMPORT_MODE', ''); vi.stubEnv('VERCEL_ENV', 'production');
    const res = response(); await handler({ method: 'POST', body: { sku: '78446', copy: draft } }, res);
    expect(res.statusCode).toBe(403); expect(getStockClient).not.toHaveBeenCalled();
  });
  it('rejects malformed copy and missing version without database writes', async () => {
    for (const body of [{ sku: '78446', copy: {} }, { sku: '78446', copy: draft }]) { const res = response(); await handler({ method: 'POST', body }, res); expect(res.statusCode).toBe(400); }
    expect(getStockClient).not.toHaveBeenCalled();
  });
  it('reads an exact Instore record in preview without making it editable', async () => {
    vi.stubEnv('INSTORE_LANDED_IMPORT_MODE', ''); const db = database(); getStockClient.mockReturnValue(db);
    const res = response(); await handler({ method: 'GET', query: { sku: '78446' } }, res);
    expect(res.json).toHaveBeenCalledWith({ item: initial, canEdit: false }); expect(db.writes).toEqual([]);
  });
  it('ignores supplied price/stock/identity changes while saving the approved text', async () => {
    const db = database(); getStockClient.mockReturnValue(db); const res = response();
    await handler({ method: 'POST', body: { sku: '78446', copy: draft, price: 1, available_stock: 999, barcode: 'WRONG', expectedUpdatedAt: initial.updated_at } }, res);
    expect(res.statusCode).toBe(200); expect(db.row.price).toBe(109.5); expect(db.row.available_stock).toBe(12);
  });
});
describe('client acknowledgements', () => {
  it('sends capitals with exact code/version and no price or stock patch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, item: { ...initial, title: 'CROCHET TOTE BAG KIT', original_description: 'INCLUDES YARN AND CROCHET HOOK' } }))));
    await updateInstoreCopy(initial, draft);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ sku: '78446', expectedUpdatedAt: initial.updated_at, copy: normalizeInstoreCopy(draft) });
  });
  it('rejects missing, mismatched and unacknowledged responses', async () => {
    for (const json of [{}, { ok: true, item: { ...initial, sku: '78445' } }, { ok: true, item: initial }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(json)))); await expect(updateInstoreCopy(initial, draft)).rejects.toThrow('did not confirm');
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ item: { ...initial, sku: 'OTHER' } })))); await expect(loadInstoreCopy('78446')).rejects.toThrow('exact');
  });
});
