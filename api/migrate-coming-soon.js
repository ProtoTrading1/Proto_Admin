import { requireAdminKey } from './_admin-auth.js';
import { readSiteConfigJson } from './_site-config.js';
import { getStockClient } from './_stock-client.js';

const COMING_SOON_FILE = 'coming-soon.json';

/** One-time migration: coming-soon SKUs → new-products staging rows. */
export default async function handler(req, res) {
  if (!(await requireAdminKey(req, res))) return;
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const config = await readSiteConfigJson(COMING_SOON_FILE, { skus: [], categoryIds: [] });
    const skus = [...new Set((config.skus || []).map((s) => String(s).trim()).filter(Boolean))];
    if (!skus.length) {
      return res.status(200).json({ ok: true, migrated: 0, skipped: 0, message: 'No SKUs in coming-soon config' });
    }

    const sb = getStockClient();
    const { data: liveRows } = await sb.from('website_stock').select('*').in('sku', skus);
    const liveBySku = new Map((liveRows || []).map((r) => [r.sku, r]));

    let migrated = 0;
    let skipped = 0;
    const flagged = [];

    for (const sku of skus) {
      const live = liveBySku.get(sku);
      if (!live) {
        flagged.push({ sku, reason: 'Not on live catalogue — review manually for Archive vs New Items' });
        skipped += 1;
        continue;
      }

      const { data: existing } = await sb
        .from('archived_products')
        .select('sku, archived_by')
        .eq('sku', sku)
        .maybeSingle();

      if (existing?.archived_by === 'new-products') {
        skipped += 1;
        continue;
      }
      if (existing && existing.archived_by !== 'new-products') {
        flagged.push({ sku, reason: `Already archived as "${existing.archived_by}" — manual review` });
        skipped += 1;
        continue;
      }

      const now = new Date().toISOString();
      const { error } = await sb.from('archived_products').insert({
        ...live,
        archived_at: now,
        archived_by: 'new-products',
        updated_at: now,
      });
      if (error) {
        flagged.push({ sku, reason: error.message });
        skipped += 1;
      } else {
        migrated += 1;
      }
    }

    return res.status(200).json({ ok: true, migrated, skipped, flagged, categoryIds: config.categoryIds || [] });
  } catch (err) {
    console.error('migrate-coming-soon:', err?.message || err);
    return res.status(500).json({ error: err.message || 'Migration failed' });
  }
}
