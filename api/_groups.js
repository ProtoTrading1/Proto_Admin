import { readFeatureFlags } from './_feature-flags.js';
import { buildGroupMaps } from '../lib/product-groups.mjs';

export const GROUP_TABLE = 'product_groups';
export const MEMBER_TABLE = 'product_group_members';

/** Load groups + their members (one extra query), newest-primary first. */
export async function fetchAllGroupsWithMembers(sb, { activeOnly = false } = {}) {
  let gq = sb.from(GROUP_TABLE)
    .select('id,title,primary_website_sku,image_url,active,created_at,updated_at')
    .order('created_at', { ascending: false });
  if (activeOnly) gq = gq.eq('active', true);
  const { data: groups, error: gErr } = await gq;
  if (gErr) throw gErr;

  const ids = (groups || []).map((g) => g.id);
  const members = [];
  if (ids.length) {
    // Paginate — a single .in() is capped at PostgREST's 1000-row default, which
    // would silently drop members (and leak them onto the listing) at scale.
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from(MEMBER_TABLE)
        .select('group_id,website_sku,variant_label,sort_order')
        .in('group_id', ids)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const batch = data || [];
      members.push(...batch);
      if (batch.length < PAGE) break;
      from += PAGE;
    }
  }
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  }
  return (groups || []).map((g) => ({
    ...g,
    members: (byGroup.get(g.id) || []).slice().sort(
      (a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9),
    ),
  }));
}

/**
 * Flag-gated context for READ paths — returns null when catalogGrouping is off,
 * so the catalogue behaves byte-identically while the feature is disabled.
 */
export async function loadGroupContextIfEnabled(sb) {
  const flags = await readFeatureFlags();
  if (!flags.catalogGrouping) return null;
  try {
    const groups = await fetchAllGroupsWithMembers(sb, { activeOnly: true });
    return { groups, ...buildGroupMaps(groups) };
  } catch (err) {
    // Flag on but migration 052 not applied yet — degrade to "off" rather than
    // 500-ing the whole admin catalogue. (detachSkuFromGroup guards the same.)
    if (err?.code === '42P01') return null;
    throw err;
  }
}
