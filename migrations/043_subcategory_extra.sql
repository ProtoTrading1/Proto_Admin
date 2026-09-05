-- 043: Support taxonomy depth beyond subcategory_four.
--
-- Product rows previously had a hard 5-level cap (category + subcategory_one
-- through subcategory_four). Admins can already nest subcategories arbitrarily
-- deep in the taxonomy tree editor, but nothing past Child 4 had a column to
-- tag a product into it — so those deeper nodes always had 0 products and
-- were filtered out of nav on both admin and the main portal ("subcategories
-- not reflecting on the site").
--
-- subcategory_extra stores everything beyond subcategory_four as a single
-- JSON array of labels, ordered shallow-to-deep, e.g. for a product filed 6
-- levels deep: ["Level 5 label","Level 6 label"]. NULL/absent for every
-- existing row (depth <= 4) — purely additive, no backfill needed, zero risk
-- to existing category data.
--
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/043_subcategory_extra.sql

ALTER TABLE website_stock ADD COLUMN IF NOT EXISTS subcategory_extra text;
ALTER TABLE archived_products ADD COLUMN IF NOT EXISTS subcategory_extra text;
