import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { mutateSiteConfigJson } from './_site-config-mutate.js';

const BUCKET = 'site-config';
const FILE = 'featured-products.json';
const MAX_ITEMS = 100;

function sameOrder(left, right) {
  return left.length === right.length && left.every((item, index) => item.sku === right[index].sku);
}

function getAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function normalizeItems(raw) {
  const seen = new Set();
  const items = [];
  for (const row of raw || []) {
    const sku = String(row?.sku || '').trim().toUpperCase();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    items.push({
      sku,
      addedAt: row?.addedAt ? String(row.addedAt) : new Date().toISOString(),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const supabase = getAdminClient();
      const { data, error } = await supabase.storage.from(BUCKET).download(FILE);
      if (error) return res.status(200).json({ items: [], updatedAt: null });
      const text = await data.text();
      const parsed = JSON.parse(text);
      return res.status(200).json({
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        updatedAt: parsed?.updatedAt || null,
      });
    } catch {
      return res.status(200).json({ items: [], updatedAt: null });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const items = normalizeItems(body.items);
      const baseUpdatedAt = body.baseUpdatedAt ? String(body.baseUpdatedAt) : null;
      const baseItems = normalizeItems(body.baseItems);
      let conflict = null;
      // Compare-and-set through the shared mutator so two admins saving at
      // once serialize instead of silently clobbering each other's list.
      const written = await mutateSiteConfigJson(FILE, { items: [], updatedAt: null }, (store) => {
        if (baseUpdatedAt && (store?.updatedAt || null) !== baseUpdatedAt) {
          const currentItems = normalizeItems(store?.items);
          if (!baseItems.length || !sameOrder(currentItems, baseItems)) {
            conflict = { currentUpdatedAt: store?.updatedAt || null };
            return { abort: true };
          }
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
      return res.status(400).json({ error: err.message || 'Save failed' });
    }
  }

  return res.status(405).end();
}
