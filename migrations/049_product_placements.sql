-- 049: Additional category placements for a product (multi-location filing).
--
-- website_stock.category + subcategory_one..four remain the CANONICAL PRIMARY
-- placement. This table holds only the ADDITIONAL locations a product should
-- also appear under, as a JSON array of stable taxonomy node ids, e.g.
--   ["school-and-office","writing","pens"]
-- Same shape as website_stock.mottaro_path (migration 038).
--
-- Node ids are stable across label renames, so renames need no cascade here.
-- Deleting a taxonomy node DOES need to prune matching rows (handled in the
-- admin taxonomy delete path, alongside clearProductsForDeletedNode).
--
-- No column is added to website_stock, so no archived_products mirror and no
-- change to the migration-027 archive/unarchive RPCs is required.
--
-- RLS: sibling Stock tables have RLS ENABLED with an explicit public-read
-- policy (website_stock_public_read). A GRANT alone is NOT sufficient — a
-- table with RLS on and no policy returns zero rows silently to anon.
-- The website currently reads Stock with a service-role key (which bypasses
-- RLS), but we mirror the website_stock posture so a future anon-side reader
-- does not hit that trap.
--
-- Deploy order: apply this migration BEFORE deploying admin code that reads
-- or writes product_placements.
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/049_product_placements.sql

CREATE TABLE IF NOT EXISTS public.product_placements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_sku text NOT NULL,
  node_path   jsonb NOT NULL,
  sort_order  integer,
  source      text NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_placements_sku_path_key UNIQUE (website_sku, node_path),
  CONSTRAINT product_placements_source_check
    CHECK (source IN ('manual', 'mottaro', 'primary'))
);

CREATE INDEX IF NOT EXISTS product_placements_sku_idx
  ON public.product_placements (website_sku);

CREATE INDEX IF NOT EXISTS product_placements_path_idx
  ON public.product_placements USING gin (node_path);

ALTER TABLE public.product_placements ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_placements'
      AND policyname = 'product_placements_public_read'
  ) THEN
    CREATE POLICY product_placements_public_read
      ON public.product_placements
      FOR SELECT TO anon, authenticated
      USING (true);
  END IF;
END $$;

GRANT SELECT ON public.product_placements TO anon, authenticated;
