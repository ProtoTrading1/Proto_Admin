import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { mutateSiteConfigJson } from './_site-config-mutate.js';

const BUCKET = 'site-config';
const FILE = 'specials.json';

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  // GET — return current specials
  if (req.method === 'GET') {
    try {
      const supabase = getAdminClient();
      const { data, error } = await supabase.storage.from(BUCKET).download(FILE);
      if (error) return res.status(200).json({ items: [], updatedAt: null });
      const text = await data.text();
      const parsed = JSON.parse(text);
      return res.status(200).json({
        ...parsed,
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        updatedAt: parsed?.updatedAt || null,
      });
    } catch {
      return res.status(200).json({ items: [], updatedAt: null });
    }
  }

  // POST — save specials (max 10)
  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const items = (body.items || []).slice(0, 10);
      const baseUpdatedAt = body.baseUpdatedAt ? String(body.baseUpdatedAt) : null;
      let conflict = null;
      // Compare-and-set through the shared mutator so two admins saving at
      // once serialize instead of silently clobbering each other's list.
      const written = await mutateSiteConfigJson(FILE, { items: [], updatedAt: null }, (store) => {
        if (baseUpdatedAt && (store?.updatedAt || null) !== baseUpdatedAt) {
          conflict = { currentUpdatedAt: store?.updatedAt || null };
          return { abort: true };
        }
        return { items };
      });
      if (conflict) {
        return res.status(409).json({
          error: 'This content was changed by someone else since you loaded it. Refresh and re-apply your edit.',
          currentUpdatedAt: conflict.currentUpdatedAt,
        });
      }
      return res.status(200).json({ ok: true, items, updatedAt: written?.updatedAt || null });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
