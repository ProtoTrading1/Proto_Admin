/**
 * Email groups — labelled mailing lists for broadcasts.
 *
 * Members live only in email_groups / email_group_members (migration 062).
 * Nothing here writes to public.customers and nothing creates an auth account,
 * so a group member can never surface in Customer Management or in any
 * audience other than their own group.
 */
import { createClient } from '@supabase/supabase-js';
import { requireAdminKey } from './_admin-auth.js';
import { normaliseGroupName, validateMemberPayload } from '../lib/email-groups.mjs';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '8mb' } } };

const INSERT_CHUNK = 500;
const MEMBER_PAGE = 200;

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function missingTable(error) {
  return /does not exist/i.test(error?.message || '');
}

/**
 * Member counts for every group in one read.
 *
 * A head-count per group was one query per group — fine at three groups,
 * needless at thirty. Only the group_id column is fetched, so the payload is
 * a uuid per member rather than the member rows themselves.
 */
async function memberCounts(supabase) {
  const counts = new Map();
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('email_group_members')
      .select('group_id')
      .range(offset, offset + 1000 - 1);
    if (error) throw error;
    const batch = data || [];
    batch.forEach((row) => {
      const key = String(row.group_id);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    if (batch.length < 1000) return counts;
    offset += 1000;
  }
}

/** Insert in chunks, ignoring anyone already on the list. */
async function addMembers(supabase, groupId, members) {
  let added = 0;
  for (let i = 0; i < members.length; i += INSERT_CHUNK) {
    const chunk = members.slice(i, i + INSERT_CHUNK).map((m) => ({ ...m, group_id: groupId }));
    // onConflict on the (group_id, lower(email)) index — a re-upload extends
    // the list rather than duplicating it or failing outright.
    const { data, error } = await supabase
      .from('email_group_members')
      .upsert(chunk, { onConflict: 'group_id,email', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    added += (data || []).length;
  }
  return added;
}

export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  const supabase = getAdminClient();

  try {
    if (req.method === 'GET') {
      const groupId = String(req.query.groupId || '').trim();

      if (groupId) {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const from = (page - 1) * MEMBER_PAGE;
        const { data, error, count } = await supabase
          .from('email_group_members')
          .select('id, email, name, business_name, created_at', { count: 'exact' })
          .eq('group_id', groupId)
          .order('created_at', { ascending: true })
          .range(from, from + MEMBER_PAGE - 1);
        if (error) throw error;
        return res.status(200).json({ members: data || [], total: count || 0, page, pageSize: MEMBER_PAGE });
      }

      const { data, error } = await supabase
        .from('email_groups')
        .select('id, name, description, created_at, updated_at')
        .order('name', { ascending: true });
      if (error) {
        if (missingTable(error)) return res.status(200).json({ available: false, groups: [] });
        throw error;
      }

      const counts = await memberCounts(supabase);
      const groups = (data || []).map((group) => ({
        ...group,
        memberCount: counts.get(String(group.id)) || 0,
      }));
      return res.status(200).json({ available: true, groups });
    }

    if (req.method === 'POST') {
      const name = normaliseGroupName(req.body?.name);
      const description = String(req.body?.description || '').trim().slice(0, 500);
      const groupId = String(req.body?.groupId || '').trim();

      const validated = validateMemberPayload(req.body?.members || []);
      if (!validated.ok) return res.status(400).json({ error: validated.error });

      // Adding to a list that already exists.
      if (groupId) {
        if (!validated.members.length) return res.status(400).json({ error: 'No valid email addresses to add' });
        const added = await addMembers(supabase, groupId, validated.members);
        await supabase.from('email_groups').update({ updated_at: new Date().toISOString() }).eq('id', groupId);
        return res.status(200).json({ ok: true, groupId, added, submitted: validated.members.length });
      }

      if (!name) return res.status(400).json({ error: 'A group name is required' });

      const { data: group, error } = await supabase
        .from('email_groups')
        .insert({ name, description })
        .select('id, name, description, created_at')
        .single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: `A group called "${name}" already exists` });
        throw error;
      }

      const added = validated.members.length ? await addMembers(supabase, group.id, validated.members) : 0;
      return res.status(200).json({ ok: true, group, added, submitted: validated.members.length });
    }

    if (req.method === 'DELETE') {
      const groupId = String(req.query.groupId || req.body?.groupId || '').trim();
      if (!groupId) return res.status(400).json({ error: 'groupId is required' });
      // Members cascade with the group (migration 062).
      const { error } = await supabase.from('email_groups').delete().eq('id', groupId);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (missingTable(error)) {
      return res.status(400).json({ error: 'Email groups are not set up in this database yet (migration 062).' });
    }
    return res.status(400).json({ error: error.message || 'Email group request failed' });
  }
}
