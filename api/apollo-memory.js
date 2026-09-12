import { verifyAdminUser, isOwnerEmail } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { buildMemoryReadAdapter, prepareMemoryRpcArgs } from '../lib/apollo-memory-store.mjs';
import { retrieveApprovedMemories } from '../lib/apollo-memory.mjs';

const MAX_BODY = 70000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MEMORY_KEY = /^[a-z0-9][a-z0-9._-]{0,119}$/;

function parseReadOptions(query = {}) {
  const q = query?.q;
  const version = query?.version;
  const cursor = query?.cursor;
  const limit = query?.limit;
  if (q != null && (typeof q !== 'string' || q.length > 240)) throw new Error('Invalid memory query');
  if (version != null && (!/^\d+$/.test(String(version)) || Number(version) < 1 || Number(version) > 2147483647)) throw new Error('Invalid memory version');
  if (cursor != null && (typeof cursor !== 'string' || !MEMORY_KEY.test(cursor))) throw new Error('Invalid memory cursor');
  if (limit != null && (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > MAX_PAGE_SIZE)) throw new Error('Invalid memory page size');
  return { query: q || '', version: version == null ? null : Number(version), cursor: cursor || null, limit: limit == null ? DEFAULT_PAGE_SIZE : Number(limit) };
}
export function getApolloMemoryClient() {
  const url = String(process.env.APOLLO_MEMORY_SUPABASE_URL || '').trim();
  const key = String(process.env.APOLLO_MEMORY_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Apollo memory database is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function createMemoryHandler({ verify = verifyAdminUser, owner = isOwnerEmail, client = getApolloMemoryClient, enabled = () => process.env.APOLLO_MEMORY_ENABLED === 'true' } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    let user;
    try { user = await verify(req); } catch { return res.status(401).json({ error: 'Sign in required' }); }
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!owner(user.email)) return res.status(403).json({ error: 'Owner access required' });
    if (!enabled()) return res.status(404).json({ error: 'Apollo memory is not enabled' });
    let readOptions;
    if (req.method === 'GET') {
      try { readOptions = parseReadOptions(req.query); } catch { return res.status(400).json({ error: 'Invalid memory query' }); }
    }
    let db;
    try { db = client(); } catch { return res.status(503).json({ error: 'Memory connection unavailable' }); }
    try {
      if (req.method === 'GET') {
        const { data, error } = await db.rpc('apollo_read_memory', { p_after_key: readOptions.cursor, p_limit: readOptions.limit });
        if (error) return res.status(503).json({ error: 'Memory could not be read' });
        const records = buildMemoryReadAdapter(data || []);
        const memories = retrieveApprovedMemories(records, readOptions);
        const keys = [...new Set(records.map(({ key }) => key))];
        const nextCursor = keys.length === readOptions.limit ? keys.at(-1) : null;
        return res.status(200).json({ memories: memories.map(({ key, kind, title, body, evidenceRefs, version, state }) => ({ key, kind, title, body, evidenceRefs, version, state })), nextCursor });
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > MAX_BODY) return res.status(400).json({ error: 'Invalid memory payload' });
      const { expectedVersion, ...payload } = req.body;
      const args = prepareMemoryRpcArgs(payload, { serverUserId: user.id, expectedVersion });
      const { data, error } = await db.rpc('apollo_append_memory', args);
      if (error) return res.status(400).json({ error: 'Memory could not be saved' });
      const memory = data && typeof data === 'object' ? (({ key, kind, title, body, evidenceRefs, evidence_refs, version, state }) => ({ key, kind, title, body, evidenceRefs: evidenceRefs || evidence_refs, version, state }))(data) : data;
      return res.status(201).json({ memory });
    } catch (error) { return res.status(error?.code === 'INVALID_MEMORY_STORE' ? 400 : 503).json({ error: error?.code === 'INVALID_MEMORY_STORE' ? 'Invalid memory request' : 'Memory unavailable' }); }
  };
}

export default createMemoryHandler();
