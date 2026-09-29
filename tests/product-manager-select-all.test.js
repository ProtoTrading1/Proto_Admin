import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manager = readFileSync(new URL('../src/components/ProductManagerEngine.jsx', import.meta.url), 'utf8');

describe('Product Manager filtered selection', () => {
  it('offers Select all for one-page filtered results, including the four GERMOL variants', () => {
    expect(manager).toContain('{rows.length > 0 && !reorderMode && (');
    expect(manager).toContain('{total > 0 && !selectAllView && (');
    expect(manager).toContain('`Select all (${total})`');
    expect(manager).toContain('onClick={() => void selectAllInView()}');
  });

  it('uses the same To order only filter when selecting as when listing', () => {
    const occurrences = manager.match(/toOrderOnly: status === 'live' && toOrderOnly/g) || [];
    expect(occurrences).toHaveLength(2);
    expect(manager).toContain('const { owned, placedOnly } = partitionPlacedOnly(allRows, browsePath)');
  });
});
