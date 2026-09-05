import { requireOwner } from './_admin-auth.js';
import { readSiteConfigJson } from './_site-config.js';
import { mutateSiteConfigJson } from './_site-config-mutate.js';

const SORT_FILE = 'sort-orders/orders.json';
const EMPTY_STORE = { orders: {}, updatedAt: null };

async function readStore() {
  return readSiteConfigJson(SORT_FILE, EMPTY_STORE);
}

/** GET sort order for a category key; POST save with optimistic version check. */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!(await requireOwner(req, res))) return;
    const categoryKey = String(req.query.categoryKey || '').trim();
    try {
      const store = await readStore();
      if (!categoryKey) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(store);
      }
      res.setHeader('Cache-Control', 'no-store');
      const entry = store.orders?.[categoryKey] || { skuOrder: [], updatedAt: null };
      return res.status(200).json({ categoryKey, ...entry, storeUpdatedAt: store.updatedAt });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    if (!(await requireOwner(req, res))) return;
    const body = req.body || {};
    const { categoryKey, skuOrder, legacyKeys = [], expectedStoreUpdatedAt } = body;
    const key = String(categoryKey || '').trim();
    if (!key || !Array.isArray(skuOrder)) {
      return res.status(400).json({ error: 'categoryKey and skuOrder[] required' });
    }
    try {
      const now = new Date().toISOString();
      let conflict = null;
      // Atomic read-modify-write (compare-and-set with retry) so a save to one
      // category can never clobber a concurrent save to another category —
      // while conflict detection stays PER CATEGORY (the old store-wide token
      // made every save invalidate every other category, producing false
      // "changed elsewhere" errors, including racing your own auto-saves).
      const result = await mutateSiteConfigJson(SORT_FILE, EMPTY_STORE, (store) => {
        const entry = store.orders?.[key] || null;
        if ('expectedCategoryUpdatedAt' in body) {
          const expectedCat = body.expectedCategoryUpdatedAt != null ? String(body.expectedCategoryUpdatedAt) : '';
          if (entry?.updatedAt && expectedCat !== entry.updatedAt) {
            conflict = { categoryUpdatedAt: entry.updatedAt };
            return { abort: true };
          }
        } else if (expectedStoreUpdatedAt != null) {
          const expected = String(expectedStoreUpdatedAt);
          if (expected && store.updatedAt && expected !== store.updatedAt) {
            conflict = {};
            return { abort: true };
          }
        }
        const nextOrders = { ...(store.orders || {}) };
        for (const legacy of legacyKeys) {
          const lk = String(legacy || '').trim();
          if (lk && lk !== key) delete nextOrders[lk];
        }
        nextOrders[key] = { skuOrder: skuOrder.map(String), updatedAt: now };
        return { store: { orders: nextOrders } };
      });
      if (conflict) {
        return res.status(409).json({ error: 'Sort order changed elsewhere — refresh and retry', ...conflict });
      }
      const storeUpdatedAt = result?.updatedAt || now;
      return res.status(200).json({
        ok: true,
        categoryKey: key,
        updatedAt: now,
        categoryUpdatedAt: now,
        storeUpdatedAt,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).end();
}
