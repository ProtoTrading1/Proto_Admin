-- Add pack_description column to website_stock and archived_products
ALTER TABLE website_stock ADD COLUMN IF NOT EXISTS pack_description text;
ALTER TABLE archived_products ADD COLUMN IF NOT EXISTS pack_description text;
