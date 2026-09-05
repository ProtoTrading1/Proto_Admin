-- 052: Variant grouping — merge several SKUs into one storefront card.
--
-- website_stock stays the canonical per-SKU truth. These two tables are an
-- OVERLAY that says "these distinct SKUs should collapse into one card with a
-- variant selector". No column is added to website_stock, so no
-- archived_products mirror and no change to the archive/unarchive RPCs.
--
-- product_groups            — one row per merged card (title, primary member).
-- product_group_members     — which SKUs belong; website_sku UNIQUE so a SKU is
--                             in at most one group. FK cascade on group delete.
--
-- Collapse happens only in the catalogue/website READ paths, gated by the
-- `catalogGrouping` feature flag. Order lines always carry the specific
-- variant's own sku/barcode, never the group.
--
-- RLS: sibling Stock tables have RLS ENABLED with an explicit public-read
-- policy (a GRANT alone returns zero rows to anon when RLS is on). The website
-- reads Stock with a service-role key (bypasses RLS), but we mirror the
-- website_stock posture so a future anon reader does not hit that trap.
--
-- Deploy order: apply BEFORE deploying admin/website code that reads or writes
-- these tables. Target: STOCK project (yiqsvwajozafvalwcero).
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/052_product_groups.sql

CREATE TABLE IF NOT EXISTS public.product_groups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text,
  primary_website_sku text NOT NULL,
  image_url           text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_groups_primary_sku_idx
  ON public.product_groups (primary_website_sku);

CREATE INDEX IF NOT EXISTS product_groups_active_idx
  ON public.product_groups (active);

CREATE TABLE IF NOT EXISTS public.product_group_members (
  group_id      uuid NOT NULL REFERENCES public.product_groups (id) ON DELETE CASCADE,
  website_sku   text NOT NULL UNIQUE,
  variant_label text,
  sort_order    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, website_sku)
);

CREATE INDEX IF NOT EXISTS product_group_members_sku_idx
  ON public.product_group_members (website_sku);

CREATE INDEX IF NOT EXISTS product_group_members_group_idx
  ON public.product_group_members (group_id);

ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_group_members ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_groups'
      AND policyname = 'product_groups_public_read'
  ) THEN
    CREATE POLICY product_groups_public_read
      ON public.product_groups
      FOR SELECT TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_group_members'
      AND policyname = 'product_group_members_public_read'
  ) THEN
    CREATE POLICY product_group_members_public_read
      ON public.product_group_members
      FOR SELECT TO anon, authenticated
      USING (true);
  END IF;
END $$;

GRANT SELECT ON public.product_groups TO anon, authenticated;
GRANT SELECT ON public.product_group_members TO anon, authenticated;
