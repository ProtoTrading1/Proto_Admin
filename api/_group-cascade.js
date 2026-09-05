import { GROUP_TABLE, MEMBER_TABLE } from './_groups.js';
import { normalizeMemberSku } from '../lib/product-groups.mjs';

/**
 * Keep variant groups consistent when a SKU leaves the LIVE catalogue (deleted
 * or archived). Removes the member row; if it was the group's primary, promotes
 * the next remaining member; if fewer than two members remain, disbands the
 * group (a group of one is just a normal product).
 *
 * Best-effort and safe to call unconditionally: it never throws (a group
 * inconsistency must not block a delete/archive), and it no-ops silently when
 * migration 052 hasn't been applied yet (the tables simply don't exist).
 *
 * @param sb a Stock-project service-role client.
 */
export async function detachSkuFromGroup(sb, sku) {
  try {
    const s = normalizeMemberSku(sku);
    if (!s) return;

    const { data: mem, error } = await sb
      .from(MEMBER_TABLE)
      .select('group_id')
      .eq('website_sku', s)
      .maybeSingle();
    if (error) {
      if (error.code === '42P01') return; // tables not created yet → no groups
      throw error;
    }
    if (!mem) return;
    const groupId = mem.group_id;

    await sb.from(MEMBER_TABLE).delete().eq('website_sku', s);

    const { data: remaining } = await sb
      .from(MEMBER_TABLE)
      .select('website_sku,sort_order')
      .eq('group_id', groupId)
      .order('sort_order', { ascending: true, nullsFirst: false });
    const rows = remaining || [];

    if (rows.length < 2) {
      await sb.from(GROUP_TABLE).delete().eq('id', groupId);
      return;
    }

    const { data: grp } = await sb
      .from(GROUP_TABLE)
      .select('primary_website_sku')
      .eq('id', groupId)
      .maybeSingle();
    const primary = normalizeMemberSku(grp?.primary_website_sku);
    if (!rows.some((r) => normalizeMemberSku(r.website_sku) === primary)) {
      await sb.from(GROUP_TABLE)
        .update({ primary_website_sku: rows[0].website_sku, updated_at: new Date().toISOString() })
        .eq('id', groupId);
    }
  } catch (err) {
    console.error('detachSkuFromGroup:', err?.message || err);
  }
}
