#!/usr/bin/env node
/**
 * Apply Ribbon_Website_Integration.xlsx taxonomy to categories.json and archived_products.
 *
 * Usage:
 *   node scripts/apply-ribbon-integration.mjs              # patch categories.json only
 *   node scripts/apply-ribbon-integration.mjs --push-taxonomy # also upload to site-config
 *   DRY_RUN=false node --env-file=.env scripts/apply-ribbon-integration.mjs --remap-archive
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const CATEGORIES_PATH = join(ROOT, 'src/data/categories.json');
const PARSED_PATH = join(ROOT, 'data/ribbon-taxonomy-parsed.json');
const BUCKET = 'site-config';
const TAXONOMY_FILE = 'taxonomy/categories.json';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const args = new Set(process.argv.slice(2));
const PUSH_TAXONOMY = args.has('--push-taxonomy');
const REMAP_ARCHIVE = args.has('--remap-archive');

export function labelToSlug(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildChildren(items, parentId = null) {
  return items.map((item) => {
    const slug = labelToSlug(item.name);
    const id = parentId ? `${parentId}-${slug}` : slug;
    const node = { id, label: item.name, children: [] };
    if (item.children?.length) {
      node.children = buildChildren(item.children, id);
    }
    return node;
  });
}

function pathToDbFields(targetPath) {
  const parts = String(targetPath || '')
    .split(/\s*>\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts[0] !== 'Textiles') return null;
  const labels = parts.slice(1);
  return {
    category: 'Textiles',
    subcategory_one: labels[0] || null,
    subcategory_two: labels[1] || null,
    subcategory_three: labels[2] || null,
    subcategory_four: labels[3] || null,
  };
}

/** Infer target path for archived ribbon SKUs not in the import sheet. */
function inferPathFromSku(sku) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s) return null;

  if (/^200082-/.test(s)) return 'Textiles > Acrylic & Blends > Florist Ribbon > 30mm';
  if (/^200083-/.test(s)) return 'Textiles > Acrylic & Blends > Florist Ribbon > 48mm';
  if (/^200077-/.test(s)) return 'Textiles > Acrylic & Blends > Pull Ribbon';
  if (/^200072-/.test(s)) return 'Textiles > Satin > 5mm';
  if (s === '8620200065') return 'Textiles > Natural > Jute Ribbon > 1.5mm';

  const org = s.match(/^ORG-[A-Z0-9]+-(\d+)$/);
  if (org) return `Textiles > Organza > ${org[1]}mm`;

  const pet = s.match(/^PET-[A-Z0-9]+-(\d+)$/);
  if (pet) {
    const w = pet[1];
    const width = w === '25' ? '32mm' : `${w}mm`;
    return `Textiles > Petersham > ${width}`;
  }

  const sat = s.match(/^SAT-[A-Z0-9]+-(\d+)$/);
  if (sat) return `Textiles > Satin > ${sat[1]}mm`;

  return null;
}

function patchCategoriesJson() {
  const parsed = JSON.parse(readFileSync(PARSED_PATH, 'utf8'));
  const hierarchy = parsed.textilesRibbonTaxonomy?.hierarchy || [];
  const ribbonChildren = buildChildren(hierarchy);

  const tree = JSON.parse(readFileSync(CATEGORIES_PATH, 'utf8'));
  const textilesIdx = tree.findIndex((c) => c.id === 'textiles');
  if (textilesIdx < 0) throw new Error('Textiles category not found in categories.json');

  tree[textilesIdx] = {
    ...tree[textilesIdx],
    label: 'Textiles',
    children: ribbonChildren,
  };

  writeFileSync(CATEGORIES_PATH, `${JSON.stringify(tree, null, 2)}\n`);
  console.log(`✓ Updated Textiles ribbon tree (${ribbonChildren.length} top-level ribbon types)`);
  return tree;
}

async function pushTaxonomy(categories) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('Skipping taxonomy push — missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const payload = JSON.stringify({ categories, updatedAt: new Date().toISOString() });
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would push taxonomy to site-config');
    return;
  }
  const { error } = await supabase.storage.from(BUCKET).upload(TAXONOMY_FILE, payload, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw error;
  console.log(`✓ Taxonomy pushed to ${BUCKET}/${TAXONOMY_FILE}`);
}

async function remapArchive() {
  const stockUrl = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const stockKey = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stockUrl || !stockKey) {
    console.warn('Skipping archive remap — missing stock Supabase credentials');
    return;
  }

  const parsed = JSON.parse(readFileSync(PARSED_PATH, 'utf8'));
  const importProducts = parsed.sheets?.['Ribbon Website Import']?.products || [];
  const skuToPath = new Map();
  for (const p of importProducts) {
    if (p.sku && p.targetPath) skuToPath.set(String(p.sku).trim().toUpperCase(), p.targetPath);
  }

  const sb = createClient(stockUrl, stockKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let page = 0;
  const pageSize = 1000;
  let updated = 0;
  let scanned = 0;
  let skipped = 0;

  while (true) {
    const { data, error } = await sb
      .from('archived_products')
      .select('sku, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .eq('category', 'Textiles')
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      scanned += 1;
      const skuKey = String(row.sku || '').trim().toUpperCase();
      const targetPath = skuToPath.get(skuKey) || inferPathFromSku(skuKey);
      if (!targetPath) {
        skipped += 1;
        continue;
      }

      const fields = pathToDbFields(targetPath);
      if (!fields) {
        skipped += 1;
        continue;
      }

      const same =
        row.category === fields.category &&
        row.subcategory_one === fields.subcategory_one &&
        (row.subcategory_two || null) === (fields.subcategory_two || null) &&
        (row.subcategory_three || null) === (fields.subcategory_three || null) &&
        (row.subcategory_four || null) === (fields.subcategory_four || null);

      if (same) continue;

      if (DRY_RUN) {
        console.log(`[DRY_RUN] ${row.sku}: → ${targetPath}`);
        updated += 1;
        continue;
      }

      const { error: upErr } = await sb
        .from('archived_products')
        .update({
          ...fields,
          updated_at: new Date().toISOString(),
        })
        .eq('sku', row.sku);

      if (upErr) {
        console.error('Update failed', row.sku, upErr.message);
        continue;
      }
      updated += 1;
    }

    if (data.length < pageSize) break;
    page += 1;
  }

  console.log(`Archive remap: scanned=${scanned} updated=${updated} skipped=${skipped} dryRun=${DRY_RUN}`);
}

const categories = patchCategoriesJson();
if (PUSH_TAXONOMY) await pushTaxonomy(categories);
if (REMAP_ARCHIVE) await remapArchive();

if (!PUSH_TAXONOMY && !REMAP_ARCHIVE) {
  console.log('\nNext steps:');
  console.log('  node --env-file=.env scripts/apply-ribbon-integration.mjs --push-taxonomy');
  console.log('  DRY_RUN=false node --env-file=.env scripts/apply-ribbon-integration.mjs --remap-archive');
}
