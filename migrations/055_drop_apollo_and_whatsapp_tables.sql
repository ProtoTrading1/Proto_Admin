-- 055: Drop the Apollo and WhatsApp tables (applied 2026-07-29).
--
-- Apollo (the admin tab + engine) and all WhatsApp/WATI messaging were removed
-- from the codebase (admin PR #179, portal PR #166). These tables belonged
-- exclusively to those features. Contents at drop time: apollo_notifications
-- 507 rows of the removed feature's own generated alerts; every other table 0
-- rows. No surviving code references any of them.

DROP TABLE IF EXISTS public.apollo_incoming_receipts CASCADE;
DROP TABLE IF EXISTS public.apollo_incoming_shipment_lines CASCADE;
DROP TABLE IF EXISTS public.apollo_incoming_shipments CASCADE;
DROP TABLE IF EXISTS public.apollo_supplier_sku_settings CASCADE;
DROP TABLE IF EXISTS public.apollo_notifications CASCADE;
DROP TABLE IF EXISTS public.whatsapp_sessions CASCADE;

-- The order-workspace document bucket was named after Apollo. It held ZERO
-- objects; new uploads go to the neutral bucket instead. Older document rows
-- carry their own storage_bucket value, so nothing else is rewritten.
-- (The empty apollo-documents bucket itself can only be deleted through the
-- Storage API/dashboard, not SQL — it is harmless until then.)
INSERT INTO storage.buckets (id, name, public)
VALUES ('workspace-documents', 'workspace-documents', false)
ON CONFLICT (id) DO NOTHING;
