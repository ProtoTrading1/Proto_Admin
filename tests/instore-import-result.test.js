import { describe, expect, it } from 'vitest';
import { parseLocalShipmentInstoreResult } from '../src/lib/productLoaderApi.js';

describe('confirmed Instore import outcomes', () => {
  it('accepts only the server-confirmed added result for the requested exact SKU', () => {
    expect(parseLocalShipmentInstoreResult({ results: [{ ok: true, sku: ' ab12 ', action: 'instore_import' }] }, 'AB12'))
      .toMatchObject({ outcome: 'added' });
  });

  it.each(['already_on_main_site', 'already_in_instore'])('reports %s as skipped instead of added', (reason) => {
    expect(parseLocalShipmentInstoreResult({ results: [{ ok: true, sku: 'AB12', action: 'instore_skipped', skipped: true, reason }] }, 'AB12'))
      .toMatchObject({ outcome: 'skipped', reason });
  });

  it.each([
    null, {}, { results: [] }, { results: {} }, { results: [null] },
    { results: [{ ok: true, action: 'instore_import' }] },
    { results: [{ ok: true, sku: 'OTHER', action: 'instore_import' }] },
    { results: [{ ok: false, sku: 'AB12', action: 'instore_import', error: 'Rejected stock' }] },
    { results: [{ ok: 'true', sku: 'AB12', action: 'instore_import' }] },
    { results: [{ ok: true, sku: 'AB12', action: 'published' }] },
    { results: [{ ok: true, sku: 'AB12', action: 'instore_skipped', reason: 'already_in_instore' }] },
    { results: [{ ok: true, sku: 'AB12', action: 'instore_skipped', skipped: true, reason: 'unrecognized' }] },
    { results: [{ ok: true, sku: 'AB12', action: 'instore_import' }, { ok: true, sku: 'AB12', action: 'instore_import' }] },
  ])('rejects incomplete or ambiguous response %#', (response) => {
    expect(() => parseLocalShipmentInstoreResult(response, 'AB12')).toThrow();
  });

  it('preserves the server’s concrete failure reason', () => {
    expect(() => parseLocalShipmentInstoreResult({ results: [{ ok: false, sku: 'AB12', error: 'No verified selling unit' }] }, 'AB12'))
      .toThrow(/No verified selling unit/);
  });
});
