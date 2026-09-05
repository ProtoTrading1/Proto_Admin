import { describe, expect, it } from 'vitest';
import { appendPlacedRows } from '../api/catalog.js';

const PLACED = {
  P1: { sku: 'P1', title: 'Alpha', to_order: false },
  P2: { sku: 'P2', title: 'Zulu', to_order: true },
};

/** Stand-in for the Supabase `.from().select().in()` chain. */
function fakeStock(byS = PLACED, calls = []) {
  return {
    from() {
      return {
        select() { return this; },
        in(_col, skus) {
          calls.push(skus);
          return Promise.resolve({ data: skus.map((s) => byS[s]).filter(Boolean), error: null });
        },
      };
    },
  };
}

describe('appendPlacedRows', () => {
  it('returns the rows untouched when nothing is placed', async () => {
    const rows = [{ sku: 'A', title: 'A' }];
    const calls = [];
    expect(await appendPlacedRows(fakeStock(PLACED, calls), rows, new Set(), 'title')).toBe(rows);
    expect(calls).toHaveLength(0);
  });

  it('issues no query when every placed sku is already present', async () => {
    const rows = [{ sku: 'P1', title: 'Alpha' }];
    const calls = [];
    const out = await appendPlacedRows(fakeStock(PLACED, calls), rows, new Set(['P1']), 'title');
    expect(out).toBe(rows);
    expect(calls).toHaveLength(0);
  });

  it('appends a product that is in the category only via a placement', async () => {
    const rows = [{ sku: 'B', title: 'Bravo' }];
    const out = await appendPlacedRows(fakeStock(), rows, new Set(['P2']), 'title');
    expect(out.map((r) => r.sku).sort()).toEqual(['B', 'P2']);
  });

  it('re-sorts by title so appended rows are not stuck at the end', async () => {
    const rows = [{ sku: 'B', title: 'Bravo' }];
    const out = await appendPlacedRows(fakeStock(), rows, new Set(['P1']), 'title');
    expect(out.map((r) => r.title)).toEqual(['Alpha', 'Bravo']);
  });

  it('sorts newest-first when sorting by updated', async () => {
    const rows = [{ sku: 'B', title: 'Bravo', updated_at: '2026-01-01' }];
    const byS = { P3: { sku: 'P3', title: 'Later', updated_at: '2026-06-01' } };
    const out = await appendPlacedRows(fakeStock(byS), rows, new Set(['P3']), 'updated');
    expect(out.map((r) => r.sku)).toEqual(['P3', 'B']);
  });

  // Regression: fetchAllLiveRows pushes toOrderOnly into SQL, so rows fetched
  // by sku here would otherwise bypass the filter and show non-orderable
  // products in the "to order" view.
  it('does not smuggle a non-to-order product past the toOrderOnly filter', async () => {
    const rows = [{ sku: 'B', title: 'Bravo', to_order: true }];
    const out = await appendPlacedRows(fakeStock(), rows, new Set(['P1']), 'title', {
      toOrderOnly: true,
    });
    expect(out.map((r) => r.sku)).toEqual(['B']);
  });

  it('still appends a placed product that IS to-order', async () => {
    const rows = [{ sku: 'B', title: 'Bravo', to_order: true }];
    const out = await appendPlacedRows(fakeStock(), rows, new Set(['P2']), 'title', {
      toOrderOnly: true,
    });
    expect(out.map((r) => r.sku).sort()).toEqual(['B', 'P2']);
  });

  it('chunks large sku lists rather than sending one huge query', async () => {
    const many = {};
    const skus = [];
    for (let i = 0; i < 450; i += 1) {
      const sku = `S${i}`;
      many[sku] = { sku, title: `T${i}`, to_order: false };
      skus.push(sku);
    }
    const calls = [];
    const out = await appendPlacedRows(fakeStock(many, calls), [], new Set(skus), 'title');
    expect(out).toHaveLength(450);
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(200);
  });
});
