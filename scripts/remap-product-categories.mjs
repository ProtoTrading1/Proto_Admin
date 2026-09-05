/**
 * remap-product-categories.mjs
 * Remaps all website_stock products from old category labels to the new tree.
 *
 * Usage (dry run first):
 *   DRY_RUN=true  VITE_STOCK_SUPABASE_URL=... VITE_STOCK_SUPABASE_KEY=... node --env-file=.env scripts/remap-product-categories.mjs
 *   DRY_RUN=false ...  (apply changes)
 *
 * The script prints a summary table of old→new mappings and any products
 * it couldn't automatically remap (these go into UNMAPPED.csv for manual review).
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const PAGE_SIZE = 1000;

const url = process.env.VITE_STOCK_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_STOCK_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Set VITE_STOCK_SUPABASE_URL + VITE_STOCK_SUPABASE_KEY (or VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// ─── Category remapping rules ─────────────────────────────────────────────────
// Each rule: { oldCat, oldSub1?, oldSub2?, newCat, newSub1?, newSub2?, newSub3? }
// Rules are matched top-down; first match wins.
// More-specific rules (with sub1/sub2) must come before their parent.
const REMAP_RULES = [
  // ── Arts / Motarro → Stationery ───────────────────────────────────────────
  { oldCat: 'Arts', newCat: 'Stationery', newSub1: 'School & Office' },
  { oldCat: 'Motarro', newCat: 'Stationery', newSub1: 'School & Office' },

  // ── Beads, Jewellery & Accessories ────────────────────────────────────────
  // Glass beads
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', oldSub2: 'Glass Beads', newCat: 'Beads', newSub1: 'Glass' },
  // Stone / semi-precious
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', oldSub2: 'Stone & Semi-Precious', newCat: 'Beads', newSub1: 'Semi' },
  // Metal / spacer beads
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', oldSub2: 'Metal & Spacer Beads', newCat: 'Beads', newSub1: 'Metal' },
  // Acrylic / plastic
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', oldSub2: 'Acrylic & Plastic Beads', newCat: 'Beads', newSub1: 'Plastic & CCB' },
  // Wooden beads
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', oldSub2: 'Wooden Beads', newCat: 'Beads', newSub1: 'Wood' },
  // All other beads
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Beads & Stones', newCat: 'Beads' },

  // Chains, Cords & Wire → Jewellery > Findings > Stringing materials
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Chains, Cords & Wire', oldSub2: 'Chains', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Stringing materials', newSub3: 'Chain' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Chains, Cords & Wire', oldSub2: 'Cords & Thread', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Stringing materials', newSub3: 'Threads' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Chains, Cords & Wire', oldSub2: 'Wire', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Stringing materials', newSub3: 'Wire' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Chains, Cords & Wire', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Stringing materials' },

  // Charms, Pendants & Jewellery → Jewellery items
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', oldSub2: 'Finished Jewellery', oldSub3: 'Earrings', newCat: 'Jewellery', newSub1: 'Jewellery', newSub2: 'Earrings' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', oldSub2: 'Finished Jewellery', oldSub3: 'Bracelets', newCat: 'Jewellery', newSub1: 'Jewellery', newSub2: 'Bracelets' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', oldSub2: 'Finished Jewellery', oldSub3: 'Necklaces', newCat: 'Jewellery', newSub1: 'Jewellery', newSub2: 'Necklaces' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', oldSub2: 'Finished Jewellery', newCat: 'Jewellery', newSub1: 'Jewellery' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', oldSub2: 'Chandelier Crystals', newCat: 'Homeware', newSub1: 'Decor', newSub2: 'Chandelier crystals' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Charms, Pendants & Jewellery', newCat: 'Jewellery', newSub1: 'Jewellery' },

  // Findings → Jewellery > Findings
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Jewellery Findings', oldSub3: 'Clasps', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Clasps' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Jewellery Findings', oldSub3: 'Pins & Crimps', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Crimps' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Jewellery Findings', oldSub3: 'Earring Components', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Earring hooks' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Jewellery Findings', oldSub3: 'Jumprings & Split Rings', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Jumprings & Split rings' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Jewellery Findings', newCat: 'Jewellery', newSub1: 'Findings' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', oldSub2: 'Bag & Leathercraft Hardware', newCat: 'Bag & Belt Components' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Findings & Components', newCat: 'Jewellery', newSub1: 'Findings' },

  // Jewellery tools
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Jewellery tools', newCat: 'Jewellery', newSub1: 'Jewellery Tools and Equipment' },
  { oldCat: 'Beads, Jewellery & Accessories', oldSub1: 'Jewellery items', newCat: 'Jewellery', newSub1: 'Jewellery' },
  { oldCat: 'Beads, Jewellery & Accessories', newCat: 'Beads' },

  // ── Beauty & Personal Care ────────────────────────────────────────────────
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Bath & Body', newCat: 'Beauty & Personal Care', newSub1: 'Skin Care' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Cosmetics & Nails', oldSub2: 'Makeup', newCat: 'Beauty & Personal Care', newSub1: 'Cosmetics' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Cosmetics & Nails', oldSub2: 'Nails', newCat: 'Beauty & Personal Care', newSub1: 'Manicure & Grooming' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Cosmetics & Nails', newCat: 'Beauty & Personal Care', newSub1: 'Cosmetics' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Fragrance & Deodorant', newCat: 'Beauty & Personal Care', newSub1: 'Fragrances' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Hair & Beauty Tools', oldSub2: 'Hair Care', newCat: 'Beauty & Personal Care', newSub1: 'Hair Care' },
  { oldCat: 'Beauty & Personal Care', oldSub1: 'Hair & Beauty Tools', newCat: 'Beauty & Personal Care', newSub1: 'Hair Care' },
  { oldCat: 'Beauty & Personal Care', newCat: 'Beauty & Personal Care' },

  // ── Events & Parties → Party, Events & Seasonals ─────────────────────────
  { oldCat: 'Events & Parties', oldSub1: 'Party Decor', oldSub2: 'Balloons & Garlands', newCat: 'Party, Events & Seasonals', newSub1: 'Party Décor', newSub2: 'Balloon Garlands' },
  { oldCat: 'Events & Parties', oldSub1: 'Party Decor', newCat: 'Party, Events & Seasonals', newSub1: 'Party Décor' },
  { oldCat: 'Events & Parties', newCat: 'Party, Events & Seasonals' },

  // ── Fashion & Accessories ────────────────────────────────────────────────
  { oldCat: 'Fashion & Accessories', oldSub1: 'Bags', oldSub2: 'Ladies Bags', newCat: 'Fashion & Accessories', newSub1: 'Synthetic bags / Bags', newSub2: 'Handbags' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Bags', oldSub2: 'Kids Bags', newCat: 'Fashion & Accessories', newSub1: 'Synthetic bags / Bags', newSub2: 'Small accessories' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Bags', oldSub2: 'Cosmetic & Toiletry Bags', newCat: 'Fashion & Accessories', newSub1: 'Synthetic bags / Bags', newSub2: 'Small accessories' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Bags', oldSub2: 'Casual & Utility Bags', newCat: 'Fashion & Accessories', newSub1: 'Synthetic bags / Bags' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Bags', newCat: 'Fashion & Accessories', newSub1: 'Synthetic bags / Bags' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Hats, Sunglasses & Accessories', oldSub2: 'Sunglasses & Eyewear', newCat: 'Fashion & Accessories', newSub1: 'Hats & Caps' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Hats, Sunglasses & Accessories', newCat: 'Fashion & Accessories', newSub1: 'Hats & Caps' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Scarves & Wraps', newCat: 'Fashion & Accessories', newSub1: 'Scarves' },
  { oldCat: 'Fashion & Accessories', oldSub1: 'Wallets & Purses', newCat: 'Fashion & Accessories', newSub1: 'Leather', newSub2: 'Wallets & purses' },
  { oldCat: 'Fashion & Accessories', newCat: 'Fashion & Accessories' },

  // ── Food & Drinks → Confectionery ────────────────────────────────────────
  { oldCat: 'Food & Drinks', oldSub1: 'Drinks', oldSub2: 'Coffee', newCat: 'Confectionery', newSub1: 'Coffee Pods' },
  { oldCat: 'Food & Drinks', oldSub1: 'Drinks', oldSub2: 'Soft Drinks', newCat: 'Confectionery', newSub1: 'Cooldrinks' },
  { oldCat: 'Food & Drinks', oldSub1: 'Drinks', newCat: 'Confectionery', newSub1: 'Cooldrinks' },
  { oldCat: 'Food & Drinks', oldSub1: 'Pantry & Spices', newCat: 'Confectionery', newSub1: 'Condiments' },
  { oldCat: 'Food & Drinks', oldSub1: 'Snacks & Biscuits', newCat: 'Confectionery', newSub1: 'Biscuits & Crackers' },
  { oldCat: 'Food & Drinks', newCat: 'Confectionery' },

  // ── Hardware ─────────────────────────────────────────────────────────────
  { oldCat: 'Hardware', oldSub1: 'Batteries', newCat: 'Electronics & Accessories', newSub1: 'Batteries' },
  { oldCat: 'Hardware', oldSub1: 'Electrical Accessories', newCat: 'Electronics & Accessories', newSub1: 'Plugs' },
  { oldCat: 'Hardware', oldSub1: 'Electronics & Phone Accessories', newCat: 'Electronics & Accessories' },
  { oldCat: 'Hardware', oldSub1: 'Tools', oldSub2: 'Craft & Retail Machines', newCat: 'Hardware', newSub1: 'Tools' },
  { oldCat: 'Hardware', oldSub1: 'Tools', newCat: 'Hardware', newSub1: 'Tools' },
  { oldCat: 'Hardware', newCat: 'Hardware' },

  // ── Homeware & Kitchen → Homeware ─────────────────────────────────────────
  { oldCat: 'Homeware & Kitchen', oldSub1: 'Cleaning & Household', newCat: 'Homeware', newSub1: 'Household', newSub2: 'Liquid cleansers' },
  { oldCat: 'Homeware & Kitchen', oldSub1: 'Decor & Candles', oldSub2: 'Candles & Holders', newCat: 'Homeware', newSub1: 'Scents and Aroma', newSub2: 'Candles & Diffusers' },
  { oldCat: 'Homeware & Kitchen', oldSub1: 'Decor & Candles', newCat: 'Homeware', newSub1: 'Decor' },
  { oldCat: 'Homeware & Kitchen', oldSub1: 'Kitchen & Dining', newCat: 'Homeware', newSub1: 'Kitchen' },
  { oldCat: 'Homeware & Kitchen', newCat: 'Homeware' },

  // ── Packaging → Packaging & Storage ─────────────────────────────────────
  { oldCat: 'Packaging', oldSub1: 'Gift Bags & Pouches', newCat: 'Packaging & Storage', newSub1: 'Jewellery bags' },
  { oldCat: 'Packaging', oldSub1: 'Jars, Boxes & Containers', oldSub2: 'Gift & Jewellery Boxes', newCat: 'Packaging & Storage', newSub1: 'Display Boxes', newSub2: 'Jewellery boxes' },
  { oldCat: 'Packaging', oldSub1: 'Jars, Boxes & Containers', oldSub2: 'Glass Jars', newCat: 'Homeware', newSub1: 'Kitchen', newSub2: 'Glass jars' },
  { oldCat: 'Packaging', oldSub1: 'Jars, Boxes & Containers', newCat: 'Packaging & Storage', newSub1: 'Display Boxes' },
  { oldCat: 'Packaging', oldSub1: 'Resealable & Plastic Packets', newCat: 'Packaging & Storage', newSub1: 'Packaging Packets and Bags' },
  { oldCat: 'Packaging', oldSub1: 'Retail Display & Tagging', newCat: 'Packaging & Storage', newSub1: 'Tags' },
  { oldCat: 'Packaging', newCat: 'Packaging & Storage' },

  // ── Textiles (ribbon integration) ─────────────────────────────────────────
  { oldCat: 'Textiles', oldSub1: 'Blankets & Throws', newCat: 'Homeware', newSub1: 'Bedroom', newSub2: 'Blankets' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Organza Ribbon', newCat: 'Textiles', newSub1: 'Organza' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Petersham Ribbon', newCat: 'Textiles', newSub1: 'Petersham' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Satin Ribbon', newCat: 'Textiles', newSub1: 'Satin' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Florist Ribbon', newCat: 'Textiles', newSub1: 'Acrylic & Blends', newSub2: 'Florist Ribbon' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Pull Ribbon', newCat: 'Textiles', newSub1: 'Acrylic & Blends', newSub2: 'Pull Ribbon' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', oldSub2: 'Jute Ribbon', newCat: 'Textiles', newSub1: 'Natural', newSub2: 'Jute Ribbon' },
  { oldCat: 'Textiles', oldSub1: 'Ribbon & Trim', newCat: 'Textiles', newSub1: 'Ribbon & Trim' },
  { oldCat: 'Textiles', oldSub1: 'Sewing & Haberdashery', newCat: 'Fashion & Accessories', newSub1: 'Iron-on Patch' },
  { oldCat: 'Textiles', oldSub1: 'Wool & Yarn', newCat: 'Textiles', newSub1: 'Acrylic & Blends' },
  { oldCat: 'Textiles', newCat: 'Textiles' },

  // ── Toys, Games & Kids → Kids Toys & Games ───────────────────────────────
  { oldCat: 'Toys, Games & Kids', oldSub1: 'Games & Puzzles', newCat: 'Kids Toys & Games', newSub1: 'Games' },
  { oldCat: 'Toys, Games & Kids', oldSub1: 'Kids Essentials', oldSub2: 'Kids Furniture', newCat: 'Kids Toys & Games', newSub1: 'Kids Furniture' },
  { oldCat: 'Toys, Games & Kids', oldSub1: 'Toys', oldSub2: 'Soft Toys', newCat: 'Kids Toys & Games', newSub1: 'Soft Toys' },
  { oldCat: 'Toys, Games & Kids', oldSub1: 'Toys', newCat: 'Kids Toys & Games', newSub1: 'Kids Toys' },
  { oldCat: 'Toys, Games & Kids', newCat: 'Kids Toys & Games' },

  // ── Products already partially on new tree (need label normalisation) ─────
  // Beads sub-categories
  { oldCat: 'Beads', oldSub1: 'Glass', newCat: 'Beads', newSub1: 'Glass' },
  { oldCat: 'Beads', oldSub1: 'Plastic & CCB', newCat: 'Beads', newSub1: 'Plastic & CCB' },
  { oldCat: 'Beads', oldSub1: 'Chains, Cords & Wire', newCat: 'Jewellery', newSub1: 'Findings', newSub2: 'Stringing materials' },
  { oldCat: 'Beads', oldSub1: 'Charms, Pendants & Jewellery', newCat: 'Jewellery', newSub1: 'Jewellery' },
  { oldCat: 'Beads', oldSub1: 'Findings & Components', newCat: 'Jewellery', newSub1: 'Findings' },
  { oldCat: 'Beads', newCat: 'Beads' },

  // Stationery (already correct label)
  { oldCat: 'Stationery', oldSub1: 'School & Office', newCat: 'Stationery', newSub1: 'School & Office' },
  { oldCat: 'Stationery', oldSub1: 'Educational', newCat: 'Stationery', newSub1: 'Educational' },
  { oldCat: 'Stationery', newCat: 'Stationery' },

  // Packaging and Storage (old name had no &)
  { oldCat: 'Packaging and Storage', oldSub1: 'Resealable & Plastic Packets', newCat: 'Packaging & Storage', newSub1: 'Packaging Packets and Bags' },
  { oldCat: 'Packaging and Storage', oldSub1: 'Retail Display & Tagging', newCat: 'Packaging & Storage', newSub1: 'Tags' },
  { oldCat: 'Packaging and Storage', oldSub1: 'Jars, Boxes & Containers', newCat: 'Packaging & Storage', newSub1: 'Display Boxes' },
  { oldCat: 'Packaging and Storage', oldSub1: 'Gift Bags & Pouches', newCat: 'Packaging & Storage', newSub1: 'Jewellery bags' },
  { oldCat: 'Packaging and Storage', newCat: 'Packaging & Storage' },

  // Arts & Crafts variant
  { oldCat: 'Arts & Crafts', oldSub1: 'Art Supplies', newCat: 'Stationery', newSub1: 'School & Office' },
  { oldCat: 'Arts & Crafts', oldSub1: 'Crafts', newCat: 'Stationery', newSub1: 'School & Office' },
  { oldCat: 'Arts & Crafts', newCat: 'Stationery', newSub1: 'School & Office' },

  // Jewellery (already correct top-level)
  { oldCat: 'Jewellery', oldSub1: 'Fashion Jewellery', newCat: 'Jewellery', newSub1: 'Jewellery' },
  { oldCat: 'Jewellery', newCat: 'Jewellery' },
];

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

function findRule(cat, sub1, sub2, sub3) {
  for (const r of REMAP_RULES) {
    if (r.oldCat && normalize(r.oldCat) !== normalize(cat)) continue;
    if (r.oldSub1 && normalize(r.oldSub1) !== normalize(sub1)) continue;
    if (r.oldSub2 && normalize(r.oldSub2) !== normalize(sub2)) continue;
    if (r.oldSub3 && normalize(r.oldSub3) !== normalize(sub3)) continue;
    return r;
  }
  return null;
}

async function fetchAllProducts() {
  const products = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('website_stock')
      .select('id, category, subcategory_one, subcategory_two, subcategory_three, subcategory_four')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    products.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return products;
}

console.log(`DRY_RUN=${DRY_RUN}`);
console.log('Fetching products…');
const products = await fetchAllProducts();
console.log(`Fetched ${products.length} products.`);

const updates = [];
const unmapped = [];
const skipped = [];

for (const p of products) {
  const rule = findRule(p.category, p.subcategory_one, p.subcategory_two, p.subcategory_three);
  if (!rule) {
    if (!p.category) { skipped.push(p); continue; }
    unmapped.push(p);
    continue;
  }

  const newData = {
    category: rule.newCat ?? p.category,
    // Preserve original value when rule doesn't specify (avoids NOT NULL violation)
    subcategory_one: rule.newSub1 !== undefined ? rule.newSub1 : (p.subcategory_one || null),
    subcategory_two: rule.newSub2 !== undefined ? rule.newSub2 : null,
    subcategory_three: rule.newSub3 !== undefined ? rule.newSub3 : null,
    subcategory_four: null,
    updated_at: new Date().toISOString(),
  };

  // Only queue if something actually changed
  const changed =
    newData.category !== p.category ||
    newData.subcategory_one !== (p.subcategory_one || null) ||
    newData.subcategory_two !== (p.subcategory_two || null) ||
    newData.subcategory_three !== (p.subcategory_three || null);

  if (changed) updates.push({ id: p.id, ...newData, _old: p });
}

console.log(`\nResults:`);
console.log(`  ${updates.length} products to update`);
console.log(`  ${unmapped.length} unmapped (no rule found)`);
console.log(`  ${skipped.length} skipped (no category)`);

if (unmapped.length) {
  const csv = ['id,category,subcategory_one,subcategory_two,subcategory_three']
    .concat(unmapped.map(p => [p.id, p.category, p.subcategory_one, p.subcategory_two, p.subcategory_three].map(v => JSON.stringify(v ?? '')).join(',')))
    .join('\n');
  writeFileSync('UNMAPPED.csv', csv);
  console.log(`  → UNMAPPED.csv written — review and assign these manually.`);
}

if (DRY_RUN) {
  console.log('\nDRY RUN — no changes written. Re-run with DRY_RUN=false to apply.');
  // Show sample
  const sample = updates.slice(0, 5);
  if (sample.length) {
    console.log('\nSample updates:');
    for (const u of sample) {
      console.log(`  [${u.id}] "${u._old.category}" → "${u.category}" | sub1: "${u._old.subcategory_one}" → "${u.subcategory_one}"`);
    }
  }
  process.exit(0);
}

// Apply updates in batches of 100
const BATCH = 100;
let done = 0;
for (let i = 0; i < updates.length; i += BATCH) {
  const batch = updates.slice(i, i + BATCH);
  for (const u of batch) {
    const { _old, ...data } = u;
    const { error } = await supabase.from('website_stock').update(data).eq('id', u.id);
    if (error) console.error(`  ✗ ${u.id}: ${error.message}`);
    else done++;
  }
  process.stdout.write(`\r  Updated ${done}/${updates.length}…`);
}

console.log(`\n✓ Done. ${done} products remapped.`);
