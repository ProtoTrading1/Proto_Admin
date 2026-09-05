import { requireAdminKey, requireOwner } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { GROUP_TABLE, MEMBER_TABLE, fetchAllGroupsWithMembers } from './_groups.js';
import { normalizeMemberSku } from '../lib/product-groups.mjs';

function normSku(s) {
  return normalizeMemberSku(s);
}

/** SKUs from `skus` that do NOT exist in website_stock. */
async function missingSkus(sb, skus) {
  if (!skus.length) return [];
  const { data, error } = await sb.from('website_stock').select('sku').in('sku', skus);
  if (error) throw error;
  const found = new Set((data || []).map((r) => normSku(r.sku)));
  return skus.filter((s) => !found.has(s));
}

/** SKUs already in a group other than `exceptGroupId`. */
async function alreadyGrouped(sb, skus, exceptGroupId = null) {
  if (!skus.length) return [];
  const { data, error } = await sb.from(MEMBER_TABLE).select('website_sku,group_id').in('website_sku', skus);
  if (error) throw error;
  return (data || []).filter((r) => r.group_id !== exceptGroupId).map((r) => normSku(r.website_sku));
}

function parseMembers(body) {
  const raw = Array.isArray(body.members)
    ? body.members
    : (Array.isArray(body.memberSkus) ? body.memberSkus.map((s) => ({ sku: s })) : []);
  const seen = new Set();
  return raw
    .map((m, i) => ({
      sku: normSku(typeof m === 'string' ? m : m?.sku),
      variantLabel: String((typeof m === 'object' && m?.variantLabel) || '').trim() || null,
      sortOrder: Number.isFinite(Number(m?.sortOrder)) ? Number(m.sortOrder) : i,
    }))
    .filter((m) => m.sku && (seen.has(m.sku) ? false : seen.add(m.sku)));
}

/**
 * Variant groups — merge several SKUs into one storefront card (migration 052).
 * Collapse only happens in READ paths behind the `catalogGrouping` flag; these
 * writes are always available so an admin can prepare groups before enabling.
 *
 * GET    ?groupId= | ?websiteSku= | (none → all groups)
 * POST   { title, primaryWebsiteSku, members:[{sku,variantLabel,sortOrder}] }
 * PATCH  { groupId, title?, active?, primaryWebsiteSku?, addMembers?, removeMembers? }
 * DELETE ?groupId=            (cascade-deletes members)
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!(await requireAdminKey(req, res))) return;
    try {
      const sb = getStockClient();
      const groupId = String(req.query.groupId || '').trim();
      const websiteSku = normSku(req.query.websiteSku);
      const groups = await fetchAllGroupsWithMembers(sb);
      if (groupId) return res.status(200).json({ group: groups.find((g) => g.id === groupId) || null });
      if (websiteSku) {
        const group = groups.find((g) => g.members.some((m) => normSku(m.website_sku) === websiteSku)) || null;
        return res.status(200).json({ websiteSku, group });
      }
      return res.status(200).json({ groups, total: groups.length });
    } catch (err) {
      console.error('product-groups GET:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to load groups' });
    }
  }

  if (req.method === 'POST') {
    if (!(await requireOwner(req, res))) return;
    try {
      const sb = getStockClient();
      const body = req.body || {};
      const title = String(body.title || '').trim() || null;
      const primary = normSku(body.primaryWebsiteSku);
      const members = parseMembers(body);

      if (members.length < 2) return res.status(400).json({ error: 'A group needs at least two products.' });
      if (!primary) return res.status(400).json({ error: 'Pick a primary product for the group.' });
      if (!members.some((m) => m.sku === primary)) {
        return res.status(400).json({ error: 'The primary product must be one of the members.' });
      }

      const skus = members.map((m) => m.sku);
      const missing = await missingSkus(sb, skus);
      if (missing.length) return res.status(400).json({ error: `Unknown product(s): ${missing.join(', ')}` });
      const taken = await alreadyGrouped(sb, skus);
      if (taken.length) return res.status(409).json({ error: `Already in another group: ${taken.join(', ')}` });

      const nowIso = new Date().toISOString();
      const { data: grp, error: gErr } = await sb.from(GROUP_TABLE)
        .insert({ title, primary_website_sku: primary, active: true, created_at: nowIso, updated_at: nowIso })
        .select('id')
        .single();
      if (gErr) throw gErr;

      const rows = members.map((m) => ({
        group_id: grp.id, website_sku: m.sku, variant_label: m.variantLabel, sort_order: m.sortOrder,
      }));
      const { error: mErr } = await sb.from(MEMBER_TABLE).insert(rows);
      if (mErr) {
        await sb.from(GROUP_TABLE).delete().eq('id', grp.id); // don't leave an empty group
        if (mErr.code === '23505') return res.status(409).json({ error: 'One of those products is already in another group.' });
        throw mErr;
      }

      const groups = await fetchAllGroupsWithMembers(sb);
      return res.status(200).json({ ok: true, groupId: grp.id, group: groups.find((g) => g.id === grp.id) || null });
    } catch (err) {
      console.error('product-groups POST:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to create group' });
    }
  }

  if (req.method === 'PATCH') {
    if (!(await requireOwner(req, res))) return;
    try {
      const sb = getStockClient();
      const body = req.body || {};
      const groupId = String(body.groupId || '').trim();
      if (!groupId) return res.status(400).json({ error: 'groupId is required' });

      // Load the current group + members first, then compute the RESULTING state
      // in memory and validate it fully before writing anything. Persisting a bad
      // primary (or dropping below two members) and only catching it afterwards
      // would leave the group in the invalid state the check rejected.
      const existing = (await fetchAllGroupsWithMembers(sb)).find((g) => g.id === groupId);
      if (!existing) return res.status(404).json({ error: 'Group not found' });

      const removeMembers = Array.isArray(body.removeMembers)
        ? new Set(body.removeMembers.map(normSku).filter(Boolean))
        : new Set();
      const addMembers = parseMembers({ members: body.addMembers || [] });

      // Resulting member SKU set: current − removed + added (dedup).
      const resultSkus = new Set(existing.members.map((m) => normSku(m.website_sku)));
      for (const s of removeMembers) resultSkus.delete(s);
      for (const m of addMembers) resultSkus.add(m.sku);

      // Resulting primary: the requested one if provided, else the unchanged one.
      const nextPrimary = body.primaryWebsiteSku !== undefined
        ? normSku(body.primaryWebsiteSku)
        : normSku(existing.primary_website_sku);

      // Validate the resulting state before any write.
      if (resultSkus.size < 2) {
        return res.status(400).json({ error: 'A group needs at least two products.' });
      }
      if (!nextPrimary || !resultSkus.has(nextPrimary)) {
        return res.status(400).json({ error: 'The primary product must be a member of the group.' });
      }
      // New members must exist and not already belong to another group.
      if (addMembers.length) {
        const skus = addMembers.map((m) => m.sku);
        const missing = await missingSkus(sb, skus);
        if (missing.length) return res.status(400).json({ error: `Unknown product(s): ${missing.join(', ')}` });
        const taken = await alreadyGrouped(sb, skus, groupId);
        if (taken.length) return res.status(409).json({ error: `Already in another group: ${taken.join(', ')}` });
      }

      // All checks passed — apply the writes.
      const patch = { updated_at: new Date().toISOString() };
      if (body.title !== undefined) patch.title = String(body.title || '').trim() || null;
      if (body.active !== undefined) patch.active = Boolean(body.active);
      if (body.primaryWebsiteSku !== undefined) patch.primary_website_sku = nextPrimary;
      const { error: uErr } = await sb.from(GROUP_TABLE).update(patch).eq('id', groupId);
      if (uErr) throw uErr;

      if (removeMembers.size) {
        const { error } = await sb.from(MEMBER_TABLE)
          .delete().eq('group_id', groupId).in('website_sku', [...removeMembers]);
        if (error) throw error;
      }
      if (addMembers.length) {
        const rows = addMembers.map((m) => ({
          group_id: groupId, website_sku: m.sku, variant_label: m.variantLabel, sort_order: m.sortOrder,
        }));
        const { error } = await sb.from(MEMBER_TABLE).insert(rows);
        if (error) {
          if (error.code === '23505') return res.status(409).json({ error: 'One of those products is already in another group.' });
          throw error;
        }
      }

      const groups = await fetchAllGroupsWithMembers(sb);
      const group = groups.find((g) => g.id === groupId) || null;
      return res.status(200).json({ ok: true, group });
    } catch (err) {
      console.error('product-groups PATCH:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to update group' });
    }
  }

  if (req.method === 'DELETE') {
    if (!(await requireOwner(req, res))) return;
    try {
      const sb = getStockClient();
      const groupId = String(req.query.groupId || req.body?.groupId || '').trim();
      if (!groupId) return res.status(400).json({ error: 'groupId is required' });
      const { error } = await sb.from(GROUP_TABLE).delete().eq('id', groupId); // ON DELETE CASCADE removes members
      if (error) throw error;
      return res.status(200).json({ ok: true, removedGroupId: groupId });
    } catch (err) {
      console.error('product-groups DELETE:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to delete group' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).end();
}
