import { requireOwner } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { GROUP_TABLE, MEMBER_TABLE, fetchAllGroupsWithMembers } from './_groups.js';
import { normalizeMemberSku } from '../lib/product-groups.mjs';
import { COLOUR_VARIANT_LABELS } from '../lib/product-colour-variants.mjs';

function normSku(value) {
  return normalizeMemberSku(value);
}

function variantCodeForSku(baseCode, sku) {
  const prefix = `${baseCode}-`;
  const upper = normSku(sku);
  if (!upper.startsWith(prefix)) return '';
  const suffix = upper.slice(prefix.length).split(/[._\s-]+/)[0];
  return COLOUR_VARIANT_LABELS[suffix] ? suffix : '';
}

function cleanGroupTitle(value) {
  return String(value || '').trim().replace(/\s*\|\s*[^|]+$/, '').trim() || null;
}

/**
 * Synchronise every published colour child for one Positill code into the
 * product-group overlay used by the storefront variant selector.
 *
 * One colour can be published safely; the group is created automatically as
 * soon as a second colour exists. Existing groups are extended, never replaced.
 */
export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body || {};
    const baseCode = normSku(body.baseCode);
    if (!baseCode) return res.status(400).json({ error: 'baseCode is required' });

    const requestedMembers = Array.isArray(body.members) ? body.members : [];
    const requestedBySku = new Map(
      requestedMembers
        .map((member, index) => {
          const sku = normSku(member?.sku);
          return [sku, {
            variantLabel: String(member?.variantLabel || '').trim() || null,
            sortOrder: Number.isFinite(Number(member?.sortOrder)) ? Number(member.sortOrder) : index,
          }];
        })
        .filter(([sku]) => sku),
    );

    const sb = getStockClient();
    const { data: stockRows, error: stockError } = await sb
      .from('website_stock')
      .select('sku,title,barcode')
      .eq('barcode', baseCode);
    if (stockError) throw stockError;

    const candidates = (stockRows || [])
      .map((row) => {
        const sku = normSku(row.sku);
        const variantCode = variantCodeForSku(baseCode, sku);
        if (!variantCode) return null;
        const requested = requestedBySku.get(sku);
        return {
          sku,
          title: String(row.title || '').trim(),
          variantLabel: requested?.variantLabel || COLOUR_VARIANT_LABELS[variantCode],
          sortOrder: requested?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (
        a.sortOrder - b.sortOrder
        || a.variantLabel.localeCompare(b.variantLabel, undefined, { sensitivity: 'base' })
      ));

    if (candidates.length < 2) {
      return res.status(200).json({
        ok: true,
        grouped: false,
        reason: 'needs_second_variant',
        variantCount: candidates.length,
      });
    }

    const candidateSkus = candidates.map((candidate) => candidate.sku);
    const { data: memberships, error: membershipError } = await sb
      .from(MEMBER_TABLE)
      .select('group_id,website_sku')
      .in('website_sku', candidateSkus);
    if (membershipError) throw membershipError;

    const groupIds = [...new Set((memberships || []).map((row) => row.group_id).filter(Boolean))];
    if (groupIds.length > 1) {
      return res.status(409).json({
        error: 'These colour variants already belong to different product groups. Review them in Product Manager.',
        code: 'multiple_groups',
      });
    }

    const requestedPrimary = normSku(body.primaryWebsiteSku);
    const preferredPrimary = candidateSkus.includes(requestedPrimary)
      ? requestedPrimary
      : candidates[0].sku;
    const title = cleanGroupTitle(body.title) || cleanGroupTitle(candidates[0].title);

    if (groupIds.length === 1) {
      const groupId = groupIds[0];
      const groups = await fetchAllGroupsWithMembers(sb);
      const group = groups.find((entry) => entry.id === groupId);
      if (!group) throw new Error('Existing product group could not be loaded');
      const currentSkus = new Set(group.members.map((member) => normSku(member.website_sku)));
      const missing = candidates.filter((candidate) => !currentSkus.has(candidate.sku));

      if (missing.length) {
        const { error } = await sb.from(MEMBER_TABLE).insert(missing.map((candidate, index) => ({
          group_id: groupId,
          website_sku: candidate.sku,
          variant_label: candidate.variantLabel,
          sort_order: group.members.length + index,
        })));
        if (error) throw error;
      }

      const groupPatch = { updated_at: new Date().toISOString() };
      if (!group.title && title) groupPatch.title = title;
      const { error: updateError } = await sb.from(GROUP_TABLE).update(groupPatch).eq('id', groupId);
      if (updateError) throw updateError;

      return res.status(200).json({
        ok: true,
        grouped: true,
        action: missing.length ? 'extended' : 'unchanged',
        groupId,
        variantCount: currentSkus.size + missing.length,
      });
    }

    const now = new Date().toISOString();
    const { data: createdGroup, error: createError } = await sb
      .from(GROUP_TABLE)
      .insert({
        title,
        primary_website_sku: preferredPrimary,
        active: true,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();
    if (createError) throw createError;

    const { error: memberInsertError } = await sb.from(MEMBER_TABLE).insert(
      candidates.map((candidate, index) => ({
        group_id: createdGroup.id,
        website_sku: candidate.sku,
        variant_label: candidate.variantLabel,
        sort_order: index,
      })),
    );
    if (memberInsertError) {
      await sb.from(GROUP_TABLE).delete().eq('id', createdGroup.id);
      throw memberInsertError;
    }

    return res.status(200).json({
      ok: true,
      grouped: true,
      action: 'created',
      groupId: createdGroup.id,
      variantCount: candidates.length,
    });
  } catch (err) {
    console.error('product-loader-colour-group:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Failed to group colour variants' });
  }
}
