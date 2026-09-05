-- 038: Persist a product's virtual Mottaro category position.
--
-- Mottaro placement was previously re-derived from the primary category
-- labels on every read, so renames/moves/deletes of primary categories
-- silently re-shuffled the Mottaro browse tree. mottaro_path stores the last
-- meaningful position as a JSON array of taxonomy node ids, e.g.
--   ["mottaro","mottaro-art-supplies","mottaro-painting-palettes"]
--
-- Deploy order: apply this migration BEFORE deploying the admin build that
-- selects mottaro_path (taxonomy counts + write paths).
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/038_mottaro_path.sql

ALTER TABLE website_stock ADD COLUMN IF NOT EXISTS mottaro_path text;
ALTER TABLE archived_products ADD COLUMN IF NOT EXISTS mottaro_path text;
