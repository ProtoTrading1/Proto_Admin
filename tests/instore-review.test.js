import { describe, expect, it } from 'vitest';
import {
  buildInstoreReview, filterInstoreReview, groupInstoreDestinations,
  normalizeReviewSku, summarizeInstoreReview, uniqueInstoreRows,
} from '../src/lib/instoreReview.js';

function product(code, extra = {}) {
  return { code, filename: `${code}.jpg`, imageSlot: 1, file: {}, group: 'ready',
    description: 'RHINESTONE STICKERS', positillSource: 'erp_sql',
    sqlRow: { CODE: code, UNITS: 'CARD', ONHAND: 30, BOOKED: 0 },
    instoreCategoryPath: ['Crafts', 'Stickers'], ...extra };
}

const review = (rows) => buildInstoreReview(rows, {
  isReady: (row) => !row.blocker,
  getBlocker: (row) => row.blocker || '',
});

describe('Instore product review model', () => {
  it('assigns one exclusive state per unique SKU with reconciling counts', () => {
    const entries = review([
      product('READY'), product('READY', { filename: 'READY-2.jpg', imageSlot: 2 }),
      product('CATEGORY', { blocker: 'Choose a destination.', instoreCategoryPath: [] }),
      product('LISTED', { existingInstore: true }),
      product('MISSING', { group: 'not_found', warnings: ['not_in_catalog'], sqlRow: null }),
    ]);
    expect(entries.map(({ state }) => state).sort()).toEqual(['attention', 'listed', 'not_found', 'ready']);
    const counts = summarizeInstoreReview(entries);
    expect(counts).toEqual({ total: 4, ready: 1, attention: 1, listed: 1, not_found: 1 });
    expect(counts.ready + counts.attention + counts.listed + counts.not_found).toBe(counts.total);
  });

  it('normalizes SKU identity and consistently chooses the first primary image', () => {
    const rows = [product(' ab12 ', { filename: 'z.jpg', imageSlot: 2 }),
      product('AB12', { filename: 'b.jpg' }), product('ab12', { filename: 'a.jpg' })];
    expect(normalizeReviewSku(' ab12 ')).toBe('AB12');
    expect(uniqueInstoreRows(rows).map(({ filename }) => filename)).toEqual(['a.jpg']);
    expect(uniqueInstoreRows([...rows].reverse()).map(({ filename }) => filename)).toEqual(['a.jpg']);
  });

  it('keeps invalid filenames individually reviewable instead of merging empty SKUs', () => {
    const entries = review([
      product('', { filename: 'unknown.jpg', parseError: 'Invalid filename', blocker: 'Check SKU.' }),
      product('', { filename: 'other.jpg', parseError: 'Invalid filename', blocker: 'Check SKU.' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.state === 'attention' && !entry.canReview)).toBe(true);
  });

  it('keeps a failed lookup in attention and recognizes known duplicates even without live data', () => {
    const entries = review([
      product('OUTAGE', { group: 'not_found', lookupError: 'Bridge offline', blocker: 'Retry live lookup.' }),
      product('DUPCHECK', { existingInstoreLookupFailed: true, blocker: 'Could not verify Instore status.' }),
      product('MAIN', { websiteStatus: 'live', sqlRow: null, blocker: 'Live data unavailable.' }),
      product('ADDED', { status: 'instore' }),
    ]);
    expect(Object.fromEntries(entries.map(({ sku, state }) => [sku, state]))).toEqual({
      OUTAGE: 'attention', DUPCHECK: 'attention', MAIN: 'listed', ADDED: 'listed',
    });
    expect(entries.filter(({ state }) => state === 'listed').every(({ canReview }) => !canReview)).toBe(true);
  });

  it('hides listed products by default and exposes separate existing-catalogue filters', () => {
    const entries = review([product('NEW'), product('INSTORE', { existingInstore: true }),
      product('MAIN', { existingOnMainSite: true }), product('BOTH', { existingInstore: true, existingOnMainSite: true })]);
    expect(filterInstoreReview(entries).map(({ sku }) => sku)).toEqual(['NEW']);
    expect(filterInstoreReview(entries, { status: 'instore' }).map(({ sku }) => sku).sort()).toEqual(['BOTH', 'INSTORE']);
    expect(filterInstoreReview(entries, { status: 'main' }).map(({ sku }) => sku).sort()).toEqual(['BOTH', 'MAIN']);
    expect(filterInstoreReview(entries, { status: 'all' })).toHaveLength(4);
  });

  it('preserves selections and saved destinations while applying search and group filters', () => {
    const rows = [product('CARD', { productGroup: 'CRAFT' }),
      product('BEAD', { description: 'METAL BEADS', productGroup: 'JEWEL', instoreCategoryPath: ['Jewellery', 'Beads'] })];
    const entries = review(rows);
    const selected = new Set(['CARD.jpg', 'BEAD.jpg']);
    expect(filterInstoreReview(entries, { query: 'metal' }).map(({ sku }) => sku)).toEqual(['BEAD']);
    expect(filterInstoreReview(entries, { query: 'card' }).map(({ sku }) => sku)).toEqual(['CARD']);
    expect(filterInstoreReview(entries, { productGroup: 'CRAFT' }).map(({ sku }) => sku)).toEqual(['CARD']);
    expect(filterInstoreReview(entries, { destination: 'Jewellery › Beads' }).map(({ sku }) => sku)).toEqual(['BEAD']);
    expect(filterInstoreReview(entries, { selectedOnly: true, selected })).toHaveLength(2);
    expect([...selected]).toEqual(['CARD.jpg', 'BEAD.jpg']);
    expect(rows[0].instoreCategoryPath).toEqual(['Crafts', 'Stickers']);
    expect(rows[1].instoreCategoryPath).toEqual(['Jewellery', 'Beads']);
  });

  it('allows selection before category assignment while keeping import readiness separate', () => {
    const [entry] = review([product('PENDING', { instoreCategoryPath: [], blocker: 'Choose a destination.' })]);
    expect(entry).toMatchObject({ state: 'attention', canReview: true, reason: 'Choose a destination.' });
  });

  it('groups the final summary by each selected product’s saved destination', () => {
    const entries = review([product('A'), product('B'), product('C', { instoreCategoryPath: [] })]);
    expect(groupInstoreDestinations(entries)).toEqual([
      { destination: 'Crafts › Stickers', count: 2, skus: ['A', 'B'] },
      { destination: 'Unassigned', count: 1, skus: ['C'] },
    ]);
  });
});
