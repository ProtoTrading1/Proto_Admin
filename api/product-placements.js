import { requireAdminKey, requireOwner } from './_admin-auth.js';
import { getStockClient } from './_stock-client.js';
import { loadTaxonomy, resolveCategoryIds, resolveLabelsFromPathIds } from './_taxonomy-utils.js';
import { normalizePlacementPath, parsePlacementInput, placementPathKey } from './_placements.js';

const TABLE = 'product_placements';

/** Primary placement from the canonical website_stock columns. */
async function loadProduct(sb, sku, tree) {
  const { data, error } = await sb
    .from('website_stock')
    .select('sku,category,subcategory_one,subcategory_two,subcategory_three,subcategory_four,subcategory_extra')
    .eq('sku', sku)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { categoryPath } = resolveCategoryIds(data, tree);
  return { row: data, primaryPath: categoryPath || [] };
}

async function listPlacements(sb, sku, tree) {
  const { data, error } = await sb
    .from(TABLE)
    .select('id,website_sku,node_path,sort_order,source,created_at')
    .eq('website_sku', sku)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => {
    const nodePath = normalizePlacementPath(row.node_path) || [];
    let labels = null;
    try {
      labels = resolveLabelsFromPathIds(tree, nodePath);
    } catch {
      // Node was deleted from the taxonomy but the placement row survives.
      // Surface it unresolved so the UI can offer to remove it.
      labels = null;
    }
    return {
      id: row.id,
      nodePath,
      key: placementPathKey(nodePath),
      labels,
      orphaned: labels === null,
      source: row.source,
      sortOrder: row.sort_order,
    };
  });
}

/**
 * Additional category placements for a product (migration 049).
 *
 * GET    ?websiteSku=SKU        list placements
 * POST   { websiteSku, nodePath }   add a placement
 * DELETE { websiteSku, nodePath } | ?id=  remove a placement
 *
 * The primary placement stays in the website_stock columns and is never
 * written here; these rows are strictly the additional locations.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!(await requireAdminKey(req, res))) return;
    const sku = String(req.query.websiteSku || '').trim();
    if (!sku) return res.status(400).json({ error: 'websiteSku is required' });
    try {
      const sb = getStockClient();
      const tree = await loadTaxonomy().catch(() => []);
      const product = await loadProduct(sb, sku, tree);
      if (!product) return res.status(404).json({ error: `Unknown product: ${sku}` });
      return res.status(200).json({
        websiteSku: sku,
        primaryPath: product.primaryPath,
        placements: await listPlacements(sb, sku, tree),
      });
    } catch (err) {
      console.error('product-placements GET:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to load placements' });
    }
  }

  if (req.method === 'POST') {
    if (!(await requireOwner(req, res))) return;
    const parsed = parsePlacementInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { sku, path } = parsed;
    try {
      const sb = getStockClient();
      const tree = await loadTaxonomy().catch(() => []);

      try {
        resolveLabelsFromPathIds(tree, path);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const product = await loadProduct(sb, sku, tree);
      if (!product) return res.status(404).json({ error: `Unknown product: ${sku}` });

      // The primary placement already puts the product here; a duplicate row
      // would show twice in the admin placement list for no benefit.
      if (placementPathKey(product.primaryPath) === placementPathKey(path)) {
        return res.status(409).json({ error: 'That is already the primary category for this product' });
      }

      const { data, error } = await sb
        .from(TABLE)
        .insert({ website_sku: sku, node_path: path, source: 'manual' })
        .select('id')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'Product is already placed in that category' });
        }
        throw error;
      }

      return res.status(200).json({
        ok: true,
        id: data?.id || null,
        websiteSku: sku,
        nodePath: path,
        placements: await listPlacements(sb, sku, tree),
      });
    } catch (err) {
      console.error('product-placements POST:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to add placement' });
    }
  }

  if (req.method === 'DELETE') {
    if (!(await requireOwner(req, res))) return;
    const id = String(req.query.id || req.body?.id || '').trim();
    const sku = String(req.query.websiteSku || req.body?.websiteSku || '').trim();
    const path = normalizePlacementPath(req.query.nodePath || req.body?.nodePath);

    if (!id && !(sku && path)) {
      return res.status(400).json({ error: 'Provide id, or websiteSku with nodePath' });
    }

    try {
      const sb = getStockClient();
      const tree = await loadTaxonomy().catch(() => []);

      let targetId = id;
      if (!targetId) {
        // Match on the normalized path key rather than a jsonb equality filter,
        // which is brittle across array encodings. A sku has few placements.
        const existing = await listPlacements(sb, sku, tree);
        const wanted = placementPathKey(path);
        targetId = existing.find((p) => p.key === wanted)?.id || '';
        if (!targetId) return res.status(404).json({ error: 'Placement not found' });
      }

      const { error } = await sb.from(TABLE).delete().eq('id', targetId);
      if (error) throw error;

      return res.status(200).json({
        ok: true,
        removedId: targetId,
        ...(sku ? { websiteSku: sku, placements: await listPlacements(sb, sku, tree) } : {}),
      });
    } catch (err) {
      console.error('product-placements DELETE:', err?.message || err);
      return res.status(500).json({ error: err.message || 'Failed to remove placement' });
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
}
