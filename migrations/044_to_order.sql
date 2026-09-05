-- 044: "To order" flag — let admins mark a product orderable at zero stock.
--
-- Distinct from keep_live_when_oos (which keeps a zero-stock product VISIBLE on
-- the site but shown as out-of-stock). to_order is what makes a zero-stock
-- product ORDERABLE by the customer, with a lead-time disclaimer on the
-- storefront. Selective by design: a zero-stock product is NOT orderable unless
-- explicitly marked to_order.
--
-- Additive and safe: defaults false, so every existing row is unaffected and the
-- archive/unarchive move functions need no change (they simply never set it, so
-- it defaults false on an archived copy — the admin re-marks a product when it
-- is made live again).
--
-- Apply with: STOCK_DATABASE_URL=postgres://... node scripts/run-migration.mjs migrations/044_to_order.sql

ALTER TABLE website_stock ADD COLUMN IF NOT EXISTS to_order boolean NOT NULL DEFAULT false;
ALTER TABLE archived_products ADD COLUMN IF NOT EXISTS to_order boolean NOT NULL DEFAULT false;
