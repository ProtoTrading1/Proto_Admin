import { requireOwner } from './_admin-auth.js';
import { createClient } from '@supabase/supabase-js';
import { readTaxonomyForApi } from './_taxonomy-utils.js';
import { normalizeLabel } from '../lib/taxonomy-match.mjs';
import { isMotarroProduct } from './_mottaro-category.js';

/**
 * Archive "floater" products — live products that do not belong to any real
 * category. A floater is a live website_stock row whose `category` is empty,
 * OR whose `category` does not match any top-level department in the taxonomy
 * (orphaned / misspelled labels that appear nowhere in the portal nav).
 *
 * Motarro products are NEVER floaters: they belong to the virtual Motarro
 * brand tree (membership is by title), so even an odd `category` still has a
 * home and must stay live.
 *
 * Archived floaters are tagged `archived_by = 'floater'` so they are a
 * distinct, restorable group in the Archive.
 *
 * POST { action: 'preview' }  → { total, byReason, byCategory, sample }
 * POST { action: 'execute' }  → { archived, failed, total }
 */

export const FLOATER_ARCHIVED_BY = 'floater';

const SCAN_COLS = 'sku, title, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four';
const PAGE = 1000;

function getStockClient() {
  return createClient(
    process.env.VITE_STOCK_SUPABASE_URL,
    process.env.VITE_STOCK_SUPABASE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function departmentLabelSet(tree) {
  return new Set((tree || []).map((n) => normalizeLabel(n.label)).filter(Boolean));
}

/** Classify a live row. Returns null when it belongs to a category. */
function floaterReason(row, deptLabels) {
  // Motarro products belong to the virtual brand tree — never a floater.
  if (isMotarroProduct(row)) return null;
  const cat = normalizeLabel(row.category);
  if (!cat) return 'empty';
  if (!deptLabels.has(cat)) return 'unmatched';
  return null;
}

async function scanFloaters(supabase, deptLabels) {
  const floaters = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select(SCAN_COLS)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data || [];
    for (const row of batch) {
      const reason = floaterReason(row, deptLabels);
      if (reason) floaters.push({ ...row, __reason: reason });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return floaters;
}

export default async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.body?.action || 'preview';
  const supabase = getStockClient();

  try {
    const { categories: tree } = await readTaxonomyForApi();
    const deptLabels = departmentLabelSet(tree);
    // Safety floor: a degraded/empty taxonomy would mark EVERY live product a
    // floater and archive the whole catalogue on one click. Refuse to run if
    // there are no real departments to match against.
    if (deptLabels.size === 0) {
      return res.status(409).json({
        error: 'Refusing to run — the category tree looks empty or failed to load, which would flag every product as a floater. Reload and try again.',
      });
    }
    const floaters = await scanFloaters(supabase, deptLabels);

    if (action === 'preview') {
      const byReason = { empty: 0, unmatched: 0 };
      const byCategoryMap = new Map();
      for (const row of floaters) {
        byReason[row.__reason] += 1;
        const label = row.__reason === 'empty' ? '(no category)' : (row.category || '(blank)');
        byCategoryMap.set(label, (byCategoryMap.get(label) || 0) + 1);
      }
      const byCategory = [...byCategoryMap.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      const sample = floaters.slice(0, 30).map((r) => ({
        sku: r.sku,
        title: r.title || r.sku,
        category: r.category || '',
        reason: r.__reason,
      }));
      return res.status(200).json({ total: floaters.length, byReason, byCategory, sample });
    }

    if (action === 'execute') {
      const skus = floaters.map((r) => r.sku).filter(Boolean);
      let archived = 0;
      const failures = [];
      const CONCURRENCY = 8;
      let cursor = 0;
      async function worker() {
        while (cursor < skus.length) {
          const sku = skus[cursor];
          cursor += 1;
          const { error } = await supabase.rpc('archive_product', {
            p_sku: sku,
            p_by: FLOATER_ARCHIVED_BY,
          });
          if (error) failures.push({ sku, error: error.message });
          else archived += 1;
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, skus.length) }, () => worker()),
      );
      return res.status(failures.length ? 207 : 200).json({
        archived,
        failed: failures,
        total: skus.length,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Floater sweep failed' });
  }
}
