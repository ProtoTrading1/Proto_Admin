-- 48h "moved" tag: record when a product was last moved between categories
-- and where it came from / went to, so the admin can see recent moves.
ALTER TABLE website_stock
  ADD COLUMN IF NOT EXISTS moved_at timestamptz,
  ADD COLUMN IF NOT EXISTS moved_from text,
  ADD COLUMN IF NOT EXISTS moved_to text;

ALTER TABLE archived_products
  ADD COLUMN IF NOT EXISTS moved_at timestamptz,
  ADD COLUMN IF NOT EXISTS moved_from text,
  ADD COLUMN IF NOT EXISTS moved_to text;
