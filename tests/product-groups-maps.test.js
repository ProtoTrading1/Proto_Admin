import { describe, expect, it } from 'vitest';
import { buildGroupMaps, normalizeMemberSku } from '../lib/product-groups.mjs';

const group = (over = {}) => ({
  id: over.id || 'g1',
  title: over.title ?? 'Widget',
  primary_website_sku: over.primary_website_sku || 'SKU1',
  active: over.active ?? true,
  members: over.members || [
    { website_sku: 'SKU1', variant_label: 'Red', sort_order: 0 },
    { website_sku: 'SKU2', variant_label: 'Blue', sort_order: 1 },
  ],
});

describe('normalizeMemberSku', () => {
  it('trims and uppercases', () => {
    expect(normalizeMemberSku(' sku1 ')).toBe('SKU1');
    expect(normalizeMemberSku(null)).toBe('');
  });
});

describe('buildGroupMaps', () => {
  it('maps every member to its group, flagging the primary', () => {
    const { bySku } = buildGroupMaps([group()]);
    expect(bySku.get('SKU1')).toMatchObject({ groupId: 'g1', groupPrimarySku: 'SKU1', isPrimary: true, variantLabel: 'Red', groupTitle: 'Widget' });
    expect(bySku.get('SKU2')).toMatchObject({ groupPrimarySku: 'SKU1', isPrimary: false, variantLabel: 'Blue' });
  });

  it('collects non-primary members for suppression (primary is never suppressed)', () => {
    const { nonPrimaryMemberSkus } = buildGroupMaps([group()]);
    expect(nonPrimaryMemberSkus).toEqual(['SKU2']);
  });

  it('normalizes member SKUs (lowercase input still matches)', () => {
    const { bySku, nonPrimaryMemberSkus } = buildGroupMaps([group({
      primary_website_sku: 'sku1',
      members: [{ website_sku: 'sku1' }, { website_sku: ' sku2 ' }],
    })]);
    expect(bySku.has('SKU1')).toBe(true);
    expect(bySku.get('SKU1').isPrimary).toBe(true);
    expect(nonPrimaryMemberSkus).toEqual(['SKU2']);
  });

  it('ignores inactive groups entirely', () => {
    const { bySku, nonPrimaryMemberSkus } = buildGroupMaps([group({ active: false })]);
    expect(bySku.size).toBe(0);
    expect(nonPrimaryMemberSkus).toEqual([]);
  });

  it('handles empty / malformed input without throwing', () => {
    expect(buildGroupMaps().nonPrimaryMemberSkus).toEqual([]);
    expect(buildGroupMaps([{ id: 'g', members: null }]).bySku.size).toBe(0);
  });
});
